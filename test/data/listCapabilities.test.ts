import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openMigratedDatabase, type OpSqliteDb } from '../../src/db/connection';
import { createList, addListItem,updateListItem,deleteListItem } from '../../src/data/lists';

describe('local list capability invariants', () => {
  let dir:string;
  let db:OpSqliteDb;
  beforeEach(async()=>{dir=mkdtempSync(join(tmpdir(),'yunote-capabilities-'));db=await openMigratedDatabase({name:'test.sqlite',location:dir});});
  afterEach(()=>{db.close();rmSync(dir,{recursive:true,force:true});});

  it('keeps existing list creation GENERIC and PERSONAL without collaboration metadata',async()=>{
    const list=await createList(db,'Дача');
    expect(list).toMatchObject({purpose:'generic',sharingMode:'personal',sharedRevision:null,collaborationRole:null});
    const item=await addListItem(db,list.id,'Лопата');
    expect(item).toMatchObject({completedByPublicClientId:null,completedByHasAvatar:false});
  });

  it('rejects a generic PARTNER list and incomplete collaborative metadata',async()=>{
    const params=['bad','Shopping List',null,0,'generic','partner',0,'partner',1,'2026-09-13','2026-09-13'];
    await expect(db.execute('INSERT INTO lists (id,title,class_id,position,purpose,sharing_mode,shared_revision,collaboration_role,rev,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',params)).rejects.toThrow(/partner requires shopping/i);
    await expect(db.execute("INSERT INTO lists (id,title,class_id,position,purpose,sharing_mode,rev,created_at,updated_at) VALUES ('bad2','Дом',NULL,0,'generic','shared',1,'2026','2026')")).rejects.toThrow(/metadata required/i);
  });

  it('requires a completion actor for SHARED only and clears actors on active items',async()=>{
    await db.execute("INSERT INTO lists (id,title,class_id,position,purpose,sharing_mode,shared_revision,collaboration_role,rev,created_at,updated_at) VALUES ('shared','Дом',NULL,0,'generic','shared',0,'editor',1,'2026','2026')");
    await db.execute("INSERT INTO lists (id,title,class_id,position,purpose,sharing_mode,shared_revision,collaboration_role,rev,created_at,updated_at) VALUES ('partner','Shopping List',NULL,0,'shopping','partner',0,'partner',1,'2026','2026')");
    await expect(db.execute("INSERT INTO list_items (id,list_id,text,checked,position,rev,created_at,updated_at) VALUES ('a','shared','Хлеб',1,0,1,'2026','2026')")).rejects.toThrow(/actor required/i);
    await expect(db.execute("INSERT INTO list_items (id,list_id,text,checked,position,rev,created_at,updated_at) VALUES ('b','partner','Хлеб',1,0,1,'2026','2026')")).resolves.toBeDefined();
    await expect(db.execute("INSERT INTO list_items (id,list_id,text,checked,position,rev,created_at,updated_at,completed_by_public_client_id) VALUES ('c','shared','Молоко',0,0,1,'2026','2026','YU-AAAA-AAAA')")).rejects.toThrow(/active item/i);
  });

  it('routes repository edits for collaborative lists to the collaboration outbox',async()=>{
    await db.execute("INSERT INTO lists (id,title,class_id,position,purpose,sharing_mode,shared_revision,collaboration_role,rev,created_at,updated_at) VALUES ('partner','Shopping List',NULL,0,'shopping','partner',2,'partner',1,'now','now')");
    const item=await addListItem(db,'partner','Bread',{id:'bread'});
    await updateListItem(db,item.id,{checked:true});
    await deleteListItem(db,item.id);
    expect((await db.execute('SELECT operation_type FROM collaboration_outbox ORDER BY expected_revision')).rows).toEqual([
      {operation_type:'add_item'},{operation_type:'set_checked'},{operation_type:'delete_item'},
    ]);
    expect((await db.execute('SELECT COUNT(*) AS count FROM mutation_journal')).rows).toEqual([{count:0}]);
  });
});
