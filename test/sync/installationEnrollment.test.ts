import {openMigratedDatabase} from '../../src/db/connection';
import {createInMemoryInstallationKeyProvider} from '../../src/security/installationKeys';
import {createInstallationEnrollmentClient} from '../../src/sync/installationEnrollment';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';

const sha256=(value:string)=>createHash('sha256').update(value).digest('hex');

describe('installation enrollment client',()=>{
  let dir:string;
  beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'yunote-enrollment-'));});
  afterEach(()=>rmSync(dir,{recursive:true,force:true}));

  it('persists pending identity before transport and only server-confirmed metadata afterwards',async()=>{
    const db=await openMigratedDatabase({name:'test.sqlite',location:dir});
    const keyProvider=createInMemoryInstallationKeyProvider({create:()=>({publicKeyPem:'-----BEGIN PUBLIC KEY-----\nP256\n-----END PUBLIC KEY-----\n',sign:()=>''}),sha256Utf8:sha256});
    const observed:Array<Record<string,unknown>>=[];
    const client=createInstallationEnrollmentClient({db,keyProvider,baseUrl:'https://cloud.example',generateId:()=> '11111111-1111-4111-8111-111111111111',
      request:async(_url,init)=>{const sent=JSON.parse(init.body);observed.push(sent);return {status:201,json:async()=>({installationId:sent.installationId,bindingId:'binding-1',replicaId:sent.replicaId,generation:sent.generation,keyVersion:sent.keyVersion,appliedRevision:0})};}});
    try{
      await expect(client.enroll('a'.repeat(64))).resolves.toMatchObject({status:'enrolled',bindingId:'binding-1'});
      expect(observed[0]).toMatchObject({token:'a'.repeat(64),installationId:'11111111-1111-4111-8111-111111111111',replicaId:expect.stringMatching(/^[0-9a-f]{32}$/),generation:1,keyVersion:1,datasetRevision:0,snapshotHash:expect.stringMatching(/^[0-9a-f]{64}$/)});
      expect((await db.execute('SELECT status,installation_id,key_alias,key_version,binding_id,applied_revision,cloud_base_url FROM installation_identity')).rows).toEqual([
        {status:'enrolled',installation_id:'11111111-1111-4111-8111-111111111111',key_alias:'yunote-installation-11111111-1111-4111-8111-111111111111',key_version:1,binding_id:'binding-1',applied_revision:0,cloud_base_url:'https://cloud.example'},
      ]);
    }finally{db.close();}
  });

  it('keeps the same pending identity when transport fails so a later attempt cannot orphan a key',async()=>{
    const db=await openMigratedDatabase({name:'test.sqlite',location:dir});
    let generated=0;
    const client=createInstallationEnrollmentClient({db,baseUrl:'https://cloud.example',generateId:()=>{generated++;return '22222222-2222-4222-8222-222222222222';},
      keyProvider:createInMemoryInstallationKeyProvider({create:alias=>({publicKeyPem:`public:${alias}`,sign:()=>''}),sha256Utf8:sha256}),request:async()=>{throw new Error('offline');}});
    try{
      await expect(client.enroll('b'.repeat(64))).rejects.toThrow('offline');
      await expect(client.enroll('c'.repeat(64))).rejects.toThrow('offline');
      expect(generated).toBe(1);
      expect((await db.execute('SELECT status,installation_id FROM installation_identity')).rows).toEqual([{status:'pending',installation_id:'22222222-2222-4222-8222-222222222222'}]);
    }finally{db.close();}
  });

  it('rejects malformed tokens locally without touching transport',async()=>{
    const db=await openMigratedDatabase({name:'test.sqlite',location:dir});let called=false;
    const client=createInstallationEnrollmentClient({db,baseUrl:'https://cloud.example',generateId:()=> '33333333-3333-4333-8333-333333333333',
      keyProvider:createInMemoryInstallationKeyProvider({create:()=>({publicKeyPem:'public',sign:()=>''}),sha256Utf8:sha256}),request:async()=>{called=true;throw new Error('unexpected');}});
    try{await expect(client.enroll('bad')).rejects.toThrow(/token/);expect(called).toBe(false);}finally{db.close();}
  });

  it('keeps enrollment pending when the cloud response names another replica',async()=>{
    const db=await openMigratedDatabase({name:'test.sqlite',location:dir});
    const client=createInstallationEnrollmentClient({db,baseUrl:'https://cloud.example',generateId:()=> '44444444-4444-4444-8444-444444444444',
      keyProvider:createInMemoryInstallationKeyProvider({create:()=>({publicKeyPem:'public',sign:()=>''}),sha256Utf8:sha256}),
      request:async()=>({status:201,json:async()=>({installationId:'44444444-4444-4444-8444-444444444444',bindingId:'binding-1',replicaId:'f'.repeat(32),generation:1,keyVersion:1,appliedRevision:0})})});
    try{
      await expect(client.enroll('d'.repeat(64))).rejects.toThrow(/does not match/);
      expect((await client.getMetadata())?.status).toBe('pending');
    }finally{db.close();}
  });

  it('hashes exactly {schemaVersion,notes,lists,listItems} -- no classes -- and is unaffected by a locally-created class',async()=>{
    const expectedHash=sha256(JSON.stringify({schemaVersion:1,notes:[],lists:[],listItems:[]}));
    const makeClient=(db:Awaited<ReturnType<typeof openMigratedDatabase>>,observed:Array<Record<string,unknown>>,installationId:string)=>
      createInstallationEnrollmentClient({db,keyProvider:createInMemoryInstallationKeyProvider({create:()=>({publicKeyPem:'public',sign:()=>''}),sha256Utf8:sha256}),
        baseUrl:'https://cloud.example',generateId:()=>installationId,
        request:async(_url,init)=>{const sent=JSON.parse(init.body);observed.push(sent);return {status:201,json:async()=>({installationId:sent.installationId,bindingId:'binding-1',replicaId:sent.replicaId,generation:sent.generation,keyVersion:sent.keyVersion,appliedRevision:0})};}});

    const db1=await openMigratedDatabase({name:'test.sqlite',location:dir});
    const observed1:Array<Record<string,unknown>>=[];
    try{
      await makeClient(db1,observed1,'55555555-5555-4555-8555-555555555555').enroll('e'.repeat(64));
      expect(observed1[0]?.snapshotHash).toBe(expectedHash);
    }finally{db1.close();}

    const dir2=mkdtempSync(join(tmpdir(),'yunote-enrollment-class-'));
    const db2=await openMigratedDatabase({name:'test.sqlite',location:dir2});
    const observed2:Array<Record<string,unknown>>=[];
    try{
      await db2.execute("INSERT INTO classes (id,name,created_at,updated_at,rev,position) VALUES ('c1','Работа','t','t',1,0)");
      await makeClient(db2,observed2,'66666666-6666-4666-8666-666666666666').enroll('f'.repeat(64));
      expect(observed2[0]?.snapshotHash).toBe(expectedHash);
    }finally{db2.close();rmSync(dir2,{recursive:true,force:true});}
  });

  it('requires TLS for enrollment transport',async()=>{
    const db=await openMigratedDatabase({name:'test.sqlite',location:dir});
    try{
      expect(()=>createInstallationEnrollmentClient({db,baseUrl:'http://cloud.example',keyProvider:createInMemoryInstallationKeyProvider({create:()=>({publicKeyPem:'public',sign:()=>''})})})).toThrow(/HTTPS/);
    }finally{db.close();}
  });
});
