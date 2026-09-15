import { mkdtempSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openMigratedDatabase,type OpSqliteDb } from '../../src/db/connection';
import { createCollaborationInbox } from '../../src/sync/collaborationInbox';

const deliveries=[
  {sequence:1,operationId:'op-1',listId:'shared-1',revision:1,type:'add_item',payload:{itemId:'item-1',text:'Молоко'}},
  {sequence:2,operationId:'op-2',listId:'shared-1',revision:2,type:'set_checked',payload:{itemId:'item-1',checked:true},actor:{publicClientId:'YU-AAAA-AAAA',displayName:'Анна',hasAvatar:true,avatarVersion:3}},
];

describe('collaboration inbox client',()=>{
  let dir:string;let db:OpSqliteDb;
  beforeEach(async()=>{
    dir=mkdtempSync(join(tmpdir(),'yunote-collaboration-inbox-'));db=await openMigratedDatabase({name:'test.sqlite',location:dir});
    const state=(await db.execute('SELECT replica_id,generation FROM dataset_state')).rows![0];
    await db.execute(`INSERT INTO installation_identity
      (singleton,status,installation_id,key_alias,key_version,binding_id,replica_id,generation,applied_revision,created_at,enrolled_at,cloud_base_url)
      VALUES (1,'enrolled','install-1','alias-1',1,'binding-1',?,?,0,'2026','2026','https://cloud.example')`,[state.replica_id,state.generation]);
    await db.execute(`INSERT INTO lists
      (id,title,class_id,position,purpose,sharing_mode,shared_revision,collaboration_role,rev,created_at,updated_at)
      VALUES ('shared-1','Дом',NULL,0,'generic','shared',0,'editor',1,'2026','2026')`);
  });
  afterEach(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
  const keys={ensureKey:async()=>({publicKeyPem:'unused'}),signUtf8:async()=> 'signature',sha256Utf8:async()=> 'hash'};

  it('applies ordered operations atomically and stores the SHARED completer in checkbox space data',async()=>{
    let ackBody='';
    const client=createCollaborationInbox({db,keyProvider:keys,baseUrl:'https://cloud.example',generateNonce:()=> 'nonce_1234567890abcdef',request:async(url,init)=>{
      if(init.method==='GET')return {status:200,json:async()=>({deliveries})};
      ackBody=init.body??'';return {status:200,json:async()=>({acknowledgedThrough:2})};
    }});
    await expect(client.pollApplyAndAcknowledge()).resolves.toEqual({status:'applied',count:2});
    expect(JSON.parse(ackBody)).toEqual({throughSequence:2});
    expect((await db.execute('SELECT text,checked,completed_by_public_client_id,completed_by_display_name,completed_by_has_avatar FROM list_items')).rows).toEqual([
      {text:'Молоко',checked:1,completed_by_public_client_id:'YU-AAAA-AAAA',completed_by_display_name:'Анна',completed_by_has_avatar:1},
    ]);
    expect((await db.execute('SELECT shared_revision FROM lists WHERE id=?',['shared-1'])).rows).toEqual([{shared_revision:2}]);
  });

  it('does not apply a delivery twice when acknowledgement failed after the local commit',async()=>{
    let failAck=true;
    const client=createCollaborationInbox({db,keyProvider:keys,baseUrl:'https://cloud.example',generateNonce:()=> 'nonce_1234567890abcdef',request:async(_url,init)=>{
      if(init.method==='GET')return {status:200,json:async()=>({deliveries:[deliveries[0]]})};
      if(failAck)throw new Error('offline');return {status:200,json:async()=>({acknowledgedThrough:1})};
    }});
    await expect(client.pollApplyAndAcknowledge()).rejects.toThrow('offline');
    failAck=false;
    await expect(client.pollApplyAndAcknowledge()).resolves.toEqual({status:'idle'});
    expect((await db.execute('SELECT COUNT(*) AS count FROM list_items')).rows).toEqual([{count:1}]);
  });

  it('rolls back the whole batch on a revision gap or missing SHARED completion actor',async()=>{
    const bad=[deliveries[0],{...deliveries[1],revision:3,actor:undefined}];
    const client=createCollaborationInbox({db,keyProvider:keys,baseUrl:'https://cloud.example',generateNonce:()=> 'nonce_1234567890abcdef',request:async()=>({status:200,json:async()=>({deliveries:bad})})});
    await expect(client.pollApplyAndAcknowledge()).rejects.toThrow(/revision gap|actor/);
    expect((await db.execute('SELECT * FROM list_items')).rows).toEqual([]);
    expect((await db.execute('SELECT acknowledged_sequence FROM collaboration_inbox_state')).rows).toEqual([{acknowledged_sequence:0}]);
  });

  it('downloads a projected member avatar with a separately signed request before acknowledgement',async()=>{
    const projection={sequence:1,operationId:'projection',listId:'shared-1',revision:0,type:'replace_projection',payload:{
      list:{id:'shared-1',title:'Дом',purpose:'generic',sharingMode:'shared',revision:0,role:'editor'},items:[],
      members:[{role:'editor',isCurrentUser:true,profile:{publicClientId:'YU-AAAA-AAAA',displayName:'Анна',hasAvatar:true,avatarVersion:3}}],
    }};
    const paths:string[]=[];
    const client=createCollaborationInbox({db,keyProvider:keys,baseUrl:'https://cloud.example',generateNonce:()=> 'nonce_1234567890abcdef',request:async(url,init)=>{
      paths.push(url);
      if(url.includes('/avatars/'))return {status:200,json:async()=>({mimeType:'image/png',base64:'aGVsbG8=',avatarVersion:3})};
      if(init.method==='GET')return {status:200,json:async()=>({deliveries:[projection]})};
      return {status:200,json:async()=>({acknowledgedThrough:1})};
    }});
    await client.pollApplyAndAcknowledge();
    expect(paths.some(path=>path.endsWith('/avatars/YU-AAAA-AAAA'))).toBe(true);
    expect((await db.execute('SELECT avatar_mime_type,avatar_base64,is_current_user FROM collaboration_members')).rows).toEqual([{avatar_mime_type:'image/png',avatar_base64:'aGVsbG8=',is_current_user:1}]);
  });

  it('rebases pending local operations onto an authoritative projection without losing them',async()=>{
    await db.execute(`INSERT INTO collaboration_outbox (operation_id,list_id,expected_revision,operation_type,payload_json,status,created_at)
      VALUES ('local','shared-1',0,'add_item','{"itemId":"local-item","text":"Local"}','pending','now')`);
    const projection={sequence:1,operationId:'projection',listId:'shared-1',revision:4,type:'replace_projection',payload:{
      list:{id:'shared-1',title:'Дом',purpose:'generic',sharingMode:'shared',revision:4,role:'editor'},items:[{id:'remote',text:'Remote',checked:false,revision:1}],
      members:[{role:'editor',isCurrentUser:true,profile:{publicClientId:'YU-AAAA-AAAA',displayName:'Анна',hasAvatar:false,avatarVersion:0}}],
    }};
    const client=createCollaborationInbox({db,keyProvider:keys,baseUrl:'https://cloud.example',request:async(_url,init)=>init.method==='GET'?{status:200,json:async()=>({deliveries:[projection]})}:{status:200,json:async()=>({acknowledgedThrough:1})}});
    await client.pollApplyAndAcknowledge();
    expect((await db.execute("SELECT id,text FROM list_items ORDER BY id")).rows).toEqual([{id:'local-item',text:'Local'},{id:'remote',text:'Remote'}]);
    expect((await db.execute("SELECT expected_revision,status FROM collaboration_outbox WHERE operation_id='local'")).rows).toEqual([{expected_revision:4,status:'pending'}]);
    expect((await db.execute("SELECT shared_revision FROM lists WHERE id='shared-1'")).rows).toEqual([{shared_revision:5}]);
  });

  it('uses a later authoritative projection to supersede conflicting earlier deliveries in the same batch',async()=>{
    await db.execute("UPDATE lists SET shared_revision=3 WHERE id='shared-1'");
    const batch=[
      {sequence:1,operationId:'remote-1',listId:'shared-1',revision:3,type:'add_item',payload:{itemId:'remote-old',text:'Old'}},
      {sequence:2,operationId:'projection',listId:'shared-1',revision:4,type:'replace_projection',payload:{
        list:{id:'shared-1',title:'Дом',purpose:'generic',sharingMode:'shared',revision:4,role:'editor'},
        items:[{id:'remote-new',text:'New',checked:false,revision:1}],members:[],
      }},
    ];
    const client=createCollaborationInbox({db,keyProvider:keys,baseUrl:'https://cloud.example',request:async(_url,init)=>init.method==='GET'?{status:200,json:async()=>({deliveries:batch})}:{status:200,json:async()=>({acknowledgedThrough:2})}});
    await expect(client.pollApplyAndAcknowledge()).resolves.toEqual({status:'applied',count:2});
    expect((await db.execute('SELECT id,text FROM list_items')).rows).toEqual([{id:'remote-new',text:'New'}]);
    expect((await db.execute('SELECT shared_revision FROM lists')).rows).toEqual([{shared_revision:4}]);
  });

  it('removes the former personal Shopping List when a partner projection is activated',async()=>{
    await db.execute(`INSERT INTO lists (id,title,class_id,position,purpose,sharing_mode,rev,created_at,updated_at)
      VALUES ('personal-shopping','Shopping List',NULL,0,'shopping','personal',4,'2026','2026')`);
    await db.execute(`INSERT INTO list_items (id,list_id,text,checked,position,rev,created_at,updated_at)
      VALUES ('old-item','personal-shopping','Old',0,0,1,'2026','2026')`);
    const projection={sequence:1,operationId:'partner',listId:'partner-1',revision:1,type:'replace_projection',payload:{
      removePersonalShoppingListId:'personal-shopping',
      list:{id:'partner-1',title:'Shopping List',purpose:'shopping',sharingMode:'partner',revision:1,role:'partner'},items:[],members:[],
    }};
    const client=createCollaborationInbox({db,keyProvider:keys,baseUrl:'https://cloud.example',request:async(_url,init)=>init.method==='GET'?{status:200,json:async()=>({deliveries:[projection]})}:{status:200,json:async()=>({acknowledgedThrough:1})}});
    await client.pollApplyAndAcknowledge();
    expect((await db.execute("SELECT id,sharing_mode FROM lists WHERE purpose='shopping'")).rows).toEqual([{id:'partner-1',sharing_mode:'partner'}]);
    expect((await db.execute("SELECT COUNT(*) AS count FROM list_items WHERE list_id='personal-shopping'")).rows).toEqual([{count:0}]);
  });

  it('advances over a redacted discarded delivery',async()=>{
    const batch=[
      {sequence:1,operationId:'discarded',listId:'shared-1',revision:1,type:'discard',payload:{}},
      {sequence:2,operationId:'removed',listId:'shared-1',revision:1,type:'remove_projection',payload:{removeListId:'shared-1'}},
    ];
    const client=createCollaborationInbox({db,keyProvider:keys,baseUrl:'https://cloud.example',request:async(_url,init)=>init.method==='GET'?{status:200,json:async()=>({deliveries:batch})}:{status:200,json:async()=>({acknowledgedThrough:2})}});
    await expect(client.pollApplyAndAcknowledge()).resolves.toEqual({status:'applied',count:2});
    expect((await db.execute("SELECT COUNT(*) AS count FROM lists WHERE id='shared-1'")).rows).toEqual([{count:0}]);
  });

  it('pulses once after applying a batch containing an add_item and a set_checked delivery',async()=>{
    const haptics={arrivalPulse:jest.fn()};
    const client=createCollaborationInbox({db,keyProvider:keys,baseUrl:'https://cloud.example',haptics,request:async(_url,init)=>init.method==='GET'?{status:200,json:async()=>({deliveries})}:{status:200,json:async()=>({acknowledgedThrough:2})}});
    await expect(client.pollApplyAndAcknowledge()).resolves.toEqual({status:'applied',count:2});
    expect(haptics.arrivalPulse).toHaveBeenCalledTimes(1);
  });

  it('does not pulse for a batch that only discards/removes a projection -- no content arrived',async()=>{
    const haptics={arrivalPulse:jest.fn()};
    const batch=[
      {sequence:1,operationId:'discarded',listId:'shared-1',revision:1,type:'discard',payload:{}},
      {sequence:2,operationId:'removed',listId:'shared-1',revision:1,type:'remove_projection',payload:{removeListId:'shared-1'}},
    ];
    const client=createCollaborationInbox({db,keyProvider:keys,baseUrl:'https://cloud.example',haptics,request:async(_url,init)=>init.method==='GET'?{status:200,json:async()=>({deliveries:batch})}:{status:200,json:async()=>({acknowledgedThrough:2})}});
    await expect(client.pollApplyAndAcknowledge()).resolves.toEqual({status:'applied',count:2});
    expect(haptics.arrivalPulse).not.toHaveBeenCalled();
  });

  it('does not pulse when there is nothing fresh to apply',async()=>{
    const haptics={arrivalPulse:jest.fn()};
    const client=createCollaborationInbox({db,keyProvider:keys,baseUrl:'https://cloud.example',haptics,request:async(_url,init)=>init.method==='GET'?{status:200,json:async()=>({deliveries:[]})}:{status:200,json:async()=>({acknowledgedThrough:0})}});
    await expect(client.pollApplyAndAcknowledge()).resolves.toEqual({status:'idle'});
    expect(haptics.arrivalPulse).not.toHaveBeenCalled();
  });
});
