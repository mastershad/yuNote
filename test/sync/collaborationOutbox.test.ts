import {openMigratedDatabase,type OpSqliteDb} from '../../src/db/connection';
import {createCollaborationOutbox} from '../../src/sync/collaborationOutbox';
import type {InstallationKeyProvider} from '../../src/security/installationKeys';

describe('collaboration outbox',()=>{
  let db:OpSqliteDb;
  const keys:InstallationKeyProvider={
    ensureKey:jest.fn(async()=>({publicKeyPem:'pem'})),signUtf8:jest.fn(async()=> 'signature'),sha256Utf8:jest.fn(async()=> 'hash'),deleteKey:jest.fn(),
  };
  beforeEach(async()=>{
    db=await openMigratedDatabase({name:`collab-outbox-${Date.now()}-${Math.random()}.db`,location:':memory:'});
    await db.execute(`INSERT INTO installation_identity
      (singleton,status,installation_id,key_alias,key_version,binding_id,replica_id,generation,applied_revision,created_at,enrolled_at,cloud_base_url)
      VALUES (1,'enrolled','install','alias',1,'binding','replica',1,0,'now','now','https://cloud.example')`);
    await db.execute(`INSERT INTO collaboration_outbox
      (operation_id,list_id,expected_revision,operation_type,payload_json,status,created_at)
      VALUES ('op-1','list-1',4,'add_item','{"itemId":"item-1","text":"Milk"}','pending','now')`);
  });
  afterEach(()=>db.close());

  it('signs and uploads the oldest operation, then marks it sent',async()=>{
    const request=jest.fn(async(_url:string,_init:{method:'POST';headers:Record<string,string>;body:string})=>({status:200,json:async()=>({status:'applied',revision:5})}));
    const result=await createCollaborationOutbox({db,keyProvider:keys,baseUrl:'https://cloud.example',request,now:()=>123,generateNonce:()=> 'nonce'}).flush();
    expect(result).toEqual({status:'uploaded',operationId:'op-1'});
    expect(JSON.parse(request.mock.calls[0][1].body)).toEqual({operationId:'op-1',listId:'list-1',expectedRevision:4,type:'add_item',payload:{itemId:'item-1',text:'Milk'}});
    expect((await db.execute("SELECT status,server_revision FROM collaboration_outbox WHERE operation_id='op-1'")).rows).toEqual([{status:'sent',server_revision:5}]);
  });

  it('keeps a rejected operation pending for safe retry or rebase',async()=>{
    const request=jest.fn(async(_url:string,_init:{method:'POST';headers:Record<string,string>;body:string})=>({status:409,json:async()=>({error:'operation_rejected'})}));
    await expect(createCollaborationOutbox({db,keyProvider:keys,baseUrl:'https://cloud.example',request}).flush()).rejects.toThrow(/409/);
    expect((await db.execute("SELECT status FROM collaboration_outbox WHERE operation_id='op-1'")).rows).toEqual([{status:'pending'}]);
  });

  it('discards all pending operations for a list after the server revokes access',async()=>{
    await db.execute(`INSERT INTO collaboration_outbox
      (operation_id,list_id,expected_revision,operation_type,payload_json,status,created_at)
      VALUES ('op-2','list-1',5,'delete_item','{"itemId":"item-1"}','pending','later')`);
    const request=jest.fn(async()=>({status:403,json:async()=>({error:'forbidden'})}));
    await expect(createCollaborationOutbox({db,keyProvider:keys,baseUrl:'https://cloud.example',request}).flush()).resolves.toEqual({status:'discarded',operationId:'op-1'});
    expect((await db.execute("SELECT status FROM collaboration_outbox WHERE list_id='list-1' ORDER BY operation_id")).rows).toEqual([{status:'sent'},{status:'sent'}]);
  });

  it('uploads pending operations by expected revision even when timestamps collide',async()=>{
    await db.execute("UPDATE collaboration_outbox SET operation_id='z-later',expected_revision=5 WHERE operation_id='op-1'");
    await db.execute(`INSERT INTO collaboration_outbox
      (operation_id,list_id,expected_revision,operation_type,payload_json,status,created_at)
      VALUES ('a-earlier','list-1',4,'add_item','{"itemId":"item-0","text":"First"}','pending','now')`);
    const request=jest.fn(async(_url:string,init:{body:string})=>({status:200,json:async()=>({status:'applied',revision:JSON.parse(init.body).expectedRevision+1})}));
    await createCollaborationOutbox({db,keyProvider:keys,baseUrl:'https://cloud.example',request}).flush();
    expect(JSON.parse(request.mock.calls[0][1].body).operationId).toBe('a-earlier');
  });
});
