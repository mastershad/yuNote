import { openMigratedDatabase } from '../../src/db/connection';
import { createClass, deleteClass } from '../../src/data/classes';
import { createNote } from '../../src/data/notes';
import { createList, addListItem, updateListItem, deleteList } from '../../src/data/lists';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('repository journal integration', () => {
  let dir:string;
  beforeEach(()=>{ dir=mkdtempSync(join(tmpdir(),'yunote-repository-journal-')); });
  afterEach(()=>rmSync(dir,{ recursive:true, force:true }));

  it('creating a class never advances dataset_state.revision or writes to mutation_journal, even alongside real synced entities',async()=>{
    const db=await openMigratedDatabase({ name:'test.sqlite',location:dir });
    try {
      const klass=await createClass(db,'Работа');
      const note=await createNote(db,{ title:'Идея',content:'Текст',classId:klass.id });
      const list=await createList(db,'Задачи',{ classId:klass.id });
      expect(klass).toMatchObject({ name:'Работа',rev:1,position:0,updatedAt:klass.createdAt });

      expect((await db.execute('SELECT revision FROM dataset_state')).rows).toEqual([{ revision:2 }]);
      const events=(await db.execute('SELECT dataset_revision,sequence,entity_type,entity_id,mutation,payload_json FROM mutation_journal ORDER BY dataset_revision,sequence')).rows ?? [];
      expect(events).toHaveLength(2);
      expect(events.map(row=>({ revision:row.dataset_revision,sequence:row.sequence,type:row.entity_type,mutation:row.mutation }))).toEqual([
        { revision:1,sequence:0,type:'note',mutation:'upsert' },
        { revision:2,sequence:0,type:'list',mutation:'upsert' },
      ]);
      expect(JSON.parse(events[0].payload_json as string)).toMatchObject({ id:note.id,classId:klass.id,rev:1 });
      expect(JSON.parse(events[1].payload_json as string)).toMatchObject({ id:list.id,classId:klass.id,rev:1 });
    } finally { db.close(); }
  });

  it('journals lists and items with class membership and position while retaining legacy outbox compatibility',async()=>{
    const db=await openMigratedDatabase({ name:'test.sqlite',location:dir });
    try {
      const klass=await createClass(db,'Дом');
      const list=await createList(db,'Покупки',{ classId:klass.id });
      const item=await addListItem(db,list.id,'Хлеб');
      const updated=await updateListItem(db,item.id,{ checked:true });
      expect(list).toMatchObject({ classId:klass.id,position:0 });
      expect(updated).toMatchObject({ checked:true,rev:2,position:0 });
      await deleteList(db,list.id);

      expect((await db.execute('SELECT revision FROM dataset_state')).rows).toEqual([{ revision:4 }]);
      const events=(await db.execute('SELECT dataset_revision,entity_type,mutation,payload_json FROM mutation_journal ORDER BY dataset_revision')).rows ?? [];
      expect(events.map(row=>[row.dataset_revision,row.entity_type,row.mutation])).toEqual([
        [1,'list','upsert'],[2,'listItem','upsert'],[3,'listItem','upsert'],[4,'list','delete'],
      ]);
      expect(JSON.parse(events[0].payload_json as string)).toMatchObject({ id:list.id,classId:klass.id,position:0 });
      expect(JSON.parse(events[2].payload_json as string)).toMatchObject({ id:item.id,checked:true,position:0 });
      expect((await db.execute('SELECT entity_type,entity_id,deleted FROM sync_outbox')).rows).toEqual([
        { entity_type:'list',entity_id:list.id,deleted:1 },
      ]);
    } finally { db.close(); }
  });
});
