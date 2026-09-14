import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openMigratedDatabase} from '../../src/db/connection';
import {createNote} from '../../src/data/notes';
import {createInstallationSync} from '../../src/sync/installationSync';
import type {InstallationKeyProvider} from '../../src/security/installationKeys';

describe('installation sync coordinator',()=>{
  it('drains bounded batches and includes a mutation that arrives during an upload',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'yunote-installation-sync-'));
    const db=await openMigratedDatabase({name:'test.sqlite',location:dir});
    const originalFetch=global.fetch;
    try{
      for(let index=1;index<=101;index++)await createNote(db,{id:`note-${index}`,title:`Note ${index}`,content:''});
      const state=(await db.execute('SELECT replica_id,generation FROM dataset_state WHERE singleton=1')).rows![0];
      await db.execute(`INSERT INTO installation_identity
        (singleton,status,installation_id,key_alias,key_version,binding_id,replica_id,generation,applied_revision,created_at,enrolled_at,cloud_base_url)
        VALUES (1,'enrolled','11111111-1111-4111-8111-111111111111','install-key',1,'binding-1',?,?,0,'2026-09-12','2026-09-12','https://cloud.example')`,
        [state.replica_id,state.generation]);
      const ranges:Array<[number,number]>=[];
      global.fetch=jest.fn(async(url,init)=>{
        if(String(url).includes('/collaboration/inbox'))return {status:200,json:async()=>({deliveries:[]})} as Response;
        const body=JSON.parse(init!.body as string) as {fromRevision:number;toRevision:number};
        ranges.push([body.fromRevision,body.toRevision]);
        if(ranges.length===1)await createNote(db,{id:'note-102',title:'Arrived during upload',content:''});
        return {status:200,json:async()=>({status:'applied',ackRevision:body.toRevision})} as Response;
      });
      const keys:InstallationKeyProvider={ensureKey:async()=>({publicKeyPem:'unused'}),signUtf8:async()=> 'signature',sha256Utf8:async()=> 'hash'};
      await expect(createInstallationSync(db,keys).flushIfEnrolled()).resolves.toBe(true);
      expect(ranges).toEqual([[1,100],[101,102]]);
      expect((await db.execute('SELECT applied_revision FROM installation_identity')).rows).toEqual([{applied_revision:102}]);
    }finally{
      global.fetch=originalFetch;
      db.close();rmSync(dir,{recursive:true,force:true});
    }
  });

  it('deletes local installation authority on unlink while retaining notes and journal',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'yunote-installation-unlink-'));
    const db=await openMigratedDatabase({name:'test.sqlite',location:dir});
    try{
      await createNote(db,{id:'kept-note',title:'Остаётся',content:'Локально'});
      const state=(await db.execute('SELECT replica_id,generation FROM dataset_state WHERE singleton=1')).rows![0];
      await db.execute(`INSERT INTO installation_identity
        (singleton,status,installation_id,key_alias,key_version,binding_id,replica_id,generation,applied_revision,created_at,enrolled_at,cloud_base_url)
        VALUES (1,'enrolled','22222222-2222-4222-8222-222222222222','install-key-delete',1,'binding-2',?,?,0,'2026-09-12','2026-09-12','https://cloud.example')`,
        [state.replica_id,state.generation]);
      const deleted:string[]=[];
      const keys:InstallationKeyProvider={ensureKey:async()=>({publicKeyPem:'unused'}),signUtf8:async()=> 'signature',sha256Utf8:async()=> 'hash',deleteKey:async alias=>{deleted.push(alias);}};
      await createInstallationSync(db,keys).unlink();
      expect(deleted).toEqual(['install-key-delete']);
      expect((await db.execute('SELECT * FROM installation_identity')).rows).toEqual([]);
      expect((await db.execute("SELECT title FROM notes WHERE id='kept-note'")).rows).toEqual([{title:'Остаётся'}]);
      expect((await db.execute('SELECT COUNT(*) AS count FROM mutation_journal')).rows).toEqual([{count:1}]);
    }finally{db.close();rmSync(dir,{recursive:true,force:true});}
  });
});
