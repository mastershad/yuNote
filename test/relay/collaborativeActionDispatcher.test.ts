import {openMigratedDatabase,type OpSqliteDb} from '../../src/db/connection';
import {applyStructuredAction} from '../../src/relay/actionDispatcher';

describe('collaborative structured actions',()=>{
  let db:OpSqliteDb;
  beforeEach(async()=>{db=await openMigratedDatabase({name:`collab-action-${Date.now()}-${Math.random()}.db`,location:':memory:'});});
  afterEach(()=>db.close());
  async function seed(role='editor'){
    await db.execute(`INSERT INTO lists (id,title,class_id,position,purpose,sharing_mode,shared_revision,collaboration_role,rev,created_at,updated_at)
      VALUES ('shared','Groceries',NULL,0,'generic','shared',7,?,1,'now','now')`,[role]);
    await db.execute(`INSERT INTO collaboration_members (list_id,public_client_id,display_name,has_avatar,avatar_version,role,is_current_user)
      VALUES ('shared','YU-ABCD-EFGH','Anna',0,0,?,1)`,[role]);
  }

  it('applies locally and queues a revisioned operation without personal journal leakage',async()=>{
    await seed();
    expect(await applyStructuredAction(db,{verb:'Capture',targetType:'listItem',targetId:'item',parentListId:'shared',content:'Milk'},'op')).toEqual({status:'applied'});
    expect((await db.execute("SELECT expected_revision,operation_type,payload_json,status FROM collaboration_outbox WHERE operation_id='op'")).rows).toEqual([
      {expected_revision:7,operation_type:'add_item',payload_json:'{"itemId":"item","text":"Milk"}',status:'pending'},
    ]);
    expect((await db.execute("SELECT shared_revision FROM lists WHERE id='shared'")).rows).toEqual([{shared_revision:8}]);
    expect((await db.execute('SELECT COUNT(*) AS count FROM mutation_journal')).rows).toEqual([{count:0}]);
  });

  it('rejects viewer mutations before touching the database',async()=>{
    await seed('viewer');
    expect(await applyStructuredAction(db,{verb:'Capture',targetType:'listItem',targetId:'item',parentListId:'shared',content:'Milk'},'op')).toEqual({status:'failed',reason:'shared: collaboration role is read-only'});
    expect((await db.execute('SELECT COUNT(*) AS count FROM collaboration_outbox')).rows).toEqual([{count:0}]);
  });

  it('clears every item of a collaborative list, not just the first',async()=>{
    await seed();
    for(const id of ['a','b','c'])await db.execute("INSERT INTO list_items (id,list_id,text,checked,position,rev,created_at,updated_at) VALUES (?,'shared','x',0,0,1,'now','now')",[id]);

    expect(await applyStructuredAction(db,{verb:'Clear',targetType:'listItem',targetId:'a',targetIds:['a','b','c'],parentListId:'shared'},'clear-op')).toEqual({status:'applied'});

    expect((await db.execute("SELECT COUNT(*) AS count FROM list_items WHERE list_id='shared'")).rows).toEqual([{count:0}]);
    expect((await db.execute("SELECT operation_id,operation_type FROM collaboration_outbox ORDER BY operation_id")).rows).toEqual([
      {operation_id:'clear-op#0',operation_type:'delete_item'},
      {operation_id:'clear-op#1',operation_type:'delete_item'},
      {operation_id:'clear-op#2',operation_type:'delete_item'},
    ]);
  });

  it('refuses to write a collaborative target into personal data when no collaborative list is present',async()=>{
    // The cloud resolved a SHARED/PARTNER list; this installation has no such
    // list locally (never synced, or the membership was revoked). Writing it as
    // a personal item is exactly the misrouting bug -- fail instead.
    await db.execute(`INSERT INTO lists (id,title,class_id,position,purpose,sharing_mode,shared_revision,collaboration_role,rev,created_at,updated_at)
      VALUES ('mine','Покупки',NULL,0,'shopping','personal',NULL,NULL,1,'now','now')`);

    const result=await applyStructuredAction(db,{verb:'Capture',targetType:'listItem',targetId:'item',parentListId:'mine',content:'Кола',sharingMode:'partner'},'op');

    expect(result).toEqual({status:'failed',reason:'mine: cloud resolved a partner list, but no collaborative list is available locally'});
    expect((await db.execute("SELECT COUNT(*) AS count FROM list_items")).rows).toEqual([{count:0}]);
  });

  it('still applies a personal action that carries no sharingMode',async()=>{
    await db.execute(`INSERT INTO lists (id,title,class_id,position,purpose,sharing_mode,shared_revision,collaboration_role,rev,created_at,updated_at)
      VALUES ('mine','Покупки',NULL,0,'shopping','personal',NULL,NULL,1,'now','now')`);

    expect(await applyStructuredAction(db,{verb:'Capture',targetType:'listItem',targetId:'item',parentListId:'mine',content:'Кола'},'op')).toEqual({status:'applied'});
    expect((await db.execute("SELECT list_id,text FROM list_items")).rows).toEqual([{list_id:'mine',text:'Кола'}]);
  });

  it('cannot express a membership or list-administration operation at all',async()=>{
    await seed('owner');
    // Design spec §3: invitations, role changes, ownership transfer, membership
    // revocation and shared-list deletion are cabinet-only. Even an owner's
    // voiced attempt has no dispatchable shape here.
    for(const verb of ['Capture','Modify','Remove','Complete','Clear'] as const){
      expect(await applyStructuredAction(db,{verb,targetType:'list',targetId:'shared',parentListId:'shared'},`admin-${verb}`))
        .toEqual({status:'failed',reason:`unsupported targetType/verb combination: list/${verb}`});
    }
    expect((await db.execute('SELECT COUNT(*) AS count FROM collaboration_outbox')).rows).toEqual([{count:0}]);
    expect((await db.execute("SELECT collaboration_role FROM lists WHERE id='shared'")).rows).toEqual([{collaboration_role:'owner'}]);
  });

  it('records the current client on SharedList completion',async()=>{
    await seed();
    await db.execute("INSERT INTO list_items (id,list_id,text,checked,position,rev,created_at,updated_at) VALUES ('item','shared','Milk',0,0,1,'now','now')");
    expect(await applyStructuredAction(db,{verb:'Complete',targetType:'listItem',targetId:'item'},'complete')).toEqual({status:'applied'});
    expect((await db.execute("SELECT checked,completed_by_public_client_id,completed_by_display_name FROM list_items WHERE id='item'")).rows).toEqual([{checked:1,completed_by_public_client_id:'YU-ABCD-EFGH',completed_by_display_name:'Anna'}]);
  });
});
