import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openMigratedDatabase,type OpSqliteDb} from '../../src/db/connection';
import {createNote} from '../../src/data/notes';
import {runLocalOperation} from '../../src/data/localOperation';
import {createJournalUploader} from '../../src/sync/journalUploader';

describe('direct journal uploader',()=>{
  let dir:string;
  let db:OpSqliteDb;

  beforeEach(async()=>{
    dir=mkdtempSync(join(tmpdir(),'yunote-journal-upload-'));
    db=await openMigratedDatabase({name:'test.sqlite',location:dir});
  });

  afterEach(()=>{
    db.close();
    rmSync(dir,{recursive:true,force:true});
  });

  async function enroll(appliedRevision=0):Promise<void>{
    const state=(await db.execute('SELECT replica_id,generation FROM dataset_state WHERE singleton=1')).rows![0];
    await db.execute(`INSERT INTO installation_identity
      (singleton,status,installation_id,key_alias,key_version,binding_id,replica_id,generation,applied_revision,created_at,enrolled_at)
      VALUES (1,'enrolled','11111111-1111-4111-8111-111111111111','install-key',1,'binding-1',?,?,?,'2026-09-12T00:00:00.000Z','2026-09-12T00:00:00.000Z')`,
      [state.replica_id,state.generation,appliedRevision]);
  }

  it('uploads the next journal revision with the exact signed request and advances only its durable cursor',async()=>{
    await createNote(db,{id:'note-1',title:'Идея',content:'Текст'});
    await enroll();
    let signed='';
    let sentBody='';
    let digestedBody='';
    let sentHeaders:Record<string,string>={};
    const uploader=createJournalUploader({
      db,
      baseUrl:'https://cloud.example/',
      keyProvider:{ensureKey:async()=>({publicKeyPem:'unused'}),signUtf8:async(_alias,message)=>{signed=message;return 'signature';},sha256Utf8:async()=> 'unused'},
      digestUtf8:async value=>{digestedBody=value;return 'body-hash';},
      now:()=>1770000000000,
      generateNonce:()=> 'nonce_1234567890abcdef',
      request:async(url,init)=>{
        expect(url).toBe('https://cloud.example/yunote/installations/journal-batch');
        sentBody=init.body;
        sentHeaders=init.headers;
        const body=JSON.parse(init.body);
        expect(body).toMatchObject({
          generation:1,
          fromRevision:1,
          toRevision:1,
          events:[{
            revision:1,
            sequence:0,
            entityType:'note',
            entityId:'note-1',
            mutation:'upsert',
            payload:{id:'note-1',title:'Идея',content:'Текст',classId:null,rev:1,position:0},
          }],
        });
        expect(body.replicaId).toMatch(/^[0-9a-f]{32}$/);
        return {status:200,json:async()=>({status:'applied',ackRevision:1})};
      },
    });

    await expect(uploader.flush()).resolves.toEqual({status:'uploaded',ackRevision:1});

    expect(sentHeaders).toEqual({
      'content-type':'application/json',
      'x-yunote-installation-id':'11111111-1111-4111-8111-111111111111',
      'x-yunote-key-version':'1',
      'x-yunote-timestamp':'1770000000000',
      'x-yunote-nonce':'nonce_1234567890abcdef',
      'x-yunote-signature':'signature',
    });
    expect(digestedBody).toBe(sentBody);
    expect(signed).toBe([
      'YUNOTE-SIGNED-REQUEST-V1',
      'POST',
      '/yunote/installations/journal-batch',
      'body-hash',
      '11111111-1111-4111-8111-111111111111',
      '1',
      '1770000000000',
      'nonce_1234567890abcdef',
    ].join('\n'));
    expect((await db.execute('SELECT applied_revision FROM installation_identity')).rows).toEqual([{applied_revision:1}]);
    expect((await db.execute('SELECT COUNT(*) AS count FROM mutation_journal')).rows).toEqual([{count:1}]);
  });

  it('keeps the cursor on a network failure and retries the same revision later',async()=>{
    await createNote(db,{id:'note-retry',title:'Офлайн',content:'Сохранено локально'});
    await enroll();
    let offline=true;
    const bodies:string[]=[];
    const uploader=createJournalUploader({db,baseUrl:'https://cloud.example',
      keyProvider:{ensureKey:async()=>({publicKeyPem:'unused'}),signUtf8:async()=> 'signature',sha256Utf8:async()=> 'hash'},
      generateNonce:()=> 'nonce_1234567890abcdef',
      request:async(_url,init)=>{bodies.push(init.body);if(offline)throw new Error('offline');return {status:200,json:async()=>({status:'applied',ackRevision:1})};},
    });

    await expect(uploader.flush()).rejects.toThrow('offline');
    expect((await db.execute('SELECT applied_revision FROM installation_identity')).rows).toEqual([{applied_revision:0}]);
    offline=false;
    await expect(uploader.flush()).resolves.toEqual({status:'uploaded',ackRevision:1});
    expect(bodies[1]).toBe(bodies[0]);
  });

  it('rejects a mismatched acknowledgement without advancing the cursor',async()=>{
    await createNote(db,{id:'note-ack',title:'Ack',content:'Mismatch'});
    await enroll();
    const uploader=createJournalUploader({db,baseUrl:'https://cloud.example',
      keyProvider:{ensureKey:async()=>({publicKeyPem:'unused'}),signUtf8:async()=> 'signature',sha256Utf8:async()=> 'hash'},
      generateNonce:()=> 'nonce_1234567890abcdef',
      request:async()=>({status:200,json:async()=>({status:'applied',ackRevision:2})}),
    });
    await expect(uploader.flush()).rejects.toThrow(/acknowledgement/);
    expect((await db.execute('SELECT applied_revision FROM installation_identity')).rows).toEqual([{applied_revision:0}]);
  });

  it('refuses to skip a missing local revision',async()=>{
    await createNote(db,{id:'note-1',title:'Один',content:''});
    await createNote(db,{id:'note-2',title:'Два',content:''});
    await db.execute('DELETE FROM mutation_journal WHERE dataset_revision=1');
    await enroll();
    let requested=false;
    const uploader=createJournalUploader({db,baseUrl:'https://cloud.example',
      keyProvider:{ensureKey:async()=>({publicKeyPem:'unused'}),signUtf8:async()=> 'signature',sha256Utf8:async()=> 'hash'},
      request:async()=>{requested=true;throw new Error('must not request');},
    });
    await expect(uploader.flush()).rejects.toThrow(/revision gap at 1/);
    expect(requested).toBe(false);
  });

  it('never splits an oversized revision and leaves it queued',async()=>{
    await runLocalOperation(db,{operationId:'large-operation',request:{action:'large'},execute:async()=>({result:{ok:true},events:[
      {entityType:'note',entityId:'large-1',mutation:'upsert',payload:{id:'large-1',title:'A',content:'x'.repeat(60_000),classId:null,rev:1,createdAt:'2026-09-12T00:00:00.000Z',updatedAt:'2026-09-12T00:00:00.000Z',position:0}},
      {entityType:'note',entityId:'large-2',mutation:'upsert',payload:{id:'large-2',title:'B',content:'x'.repeat(60_000),classId:null,rev:1,createdAt:'2026-09-12T00:00:00.000Z',updatedAt:'2026-09-12T00:00:00.000Z',position:1}},
    ]})});
    await enroll();
    let requested=false;
    const uploader=createJournalUploader({db,baseUrl:'https://cloud.example',
      keyProvider:{ensureKey:async()=>({publicKeyPem:'unused'}),signUtf8:async()=> 'signature',sha256Utf8:async()=> 'hash'},
      request:async()=>{requested=true;throw new Error('must not request');},
    });
    await expect(uploader.flush()).rejects.toThrow(/exceeds/);
    expect(requested).toBe(false);
    expect((await db.execute('SELECT applied_revision FROM installation_identity')).rows).toEqual([{applied_revision:0}]);
  });

  it('coalesces concurrent flush calls into one signed request',async()=>{
    await createNote(db,{id:'note-concurrent',title:'Один запрос',content:''});
    await enroll();
    let release!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;});
    let requests=0;
    const uploader=createJournalUploader({db,baseUrl:'https://cloud.example',
      keyProvider:{ensureKey:async()=>({publicKeyPem:'unused'}),signUtf8:async()=> 'signature',sha256Utf8:async()=> 'hash'},
      request:async()=>{requests++;await gate;return {status:200,json:async()=>({status:'applied',ackRevision:1})};},
    });
    const first=uploader.flush();
    const second=uploader.flush();
    await Promise.resolve();
    release();
    await expect(Promise.all([first,second])).resolves.toEqual([
      {status:'uploaded',ackRevision:1},{status:'uploaded',ackRevision:1},
    ]);
    expect(requests).toBe(1);
  });
});
