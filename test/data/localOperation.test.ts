import { openMigratedDatabase } from '../../src/db/connection';
import { runLocalOperation, OperationPayloadMismatchError } from '../../src/data/localOperation';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('runLocalOperation', () => {
  let dir:string;
  beforeEach(() => { dir=mkdtempSync(join(tmpdir(),'yunote-operation-')); });
  afterEach(() => rmSync(dir,{ recursive:true, force:true }));

  it('atomically commits data, one cursor revision, ordered journal events, and the result', async () => {
    const db=await openMigratedDatabase({ name:'test.sqlite', location:dir });
    try {
      const outcome=await runLocalOperation(db,{ operationId:'op-1', request:{ z:2,a:1 }, execute:async(tx)=>{
        await tx.execute("INSERT INTO notes (id,title,content,class_id,rev,created_at,updated_at,position) VALUES ('n','Идея','Текст',NULL,1,'t','t',0)");
        return { result:{ status:'applied',id:'n' }, events:[
          { entityType:'note', entityId:'n', mutation:'upsert', payload:{ id:'n',title:'Идея' } },
          { entityType:'listItem', entityId:'old', mutation:'delete' },
        ] };
      }});
      expect(outcome).toEqual({ replayed:false, revision:1, result:{ status:'applied',id:'n' } });
      expect((await db.execute('SELECT revision FROM dataset_state')).rows).toEqual([{ revision:1 }]);
      expect((await db.execute('SELECT dataset_revision,sequence,operation_id,entity_type,entity_id,mutation,payload_json FROM mutation_journal ORDER BY sequence')).rows).toEqual([
        { dataset_revision:1,sequence:0,operation_id:'op-1',entity_type:'note',entity_id:'n',mutation:'upsert',payload_json:'{"id":"n","title":"Идея"}' },
        { dataset_revision:1,sequence:1,operation_id:'op-1',entity_type:'listItem',entity_id:'old',mutation:'delete',payload_json:null },
      ]);
      expect((await db.execute('SELECT operation_id,request_json,result_json,dataset_revision FROM applied_operations')).rows).toEqual([
        { operation_id:'op-1',request_json:'{"a":1,"z":2}',result_json:'{"id":"n","status":"applied"}',dataset_revision:1 },
      ]);
    } finally { db.close(); }
  });

  it('returns the stored result on exact redelivery and rejects changed payload reuse', async () => {
    const db=await openMigratedDatabase({ name:'test.sqlite', location:dir });
    let executions=0;
    const execute=async()=>{ executions++; return { result:{ status:'applied' }, events:[{ entityType:'note' as const,entityId:'n',mutation:'delete' as const }] }; };
    try {
      await runLocalOperation(db,{ operationId:'op-1', request:{ value:1 }, execute });
      expect(await runLocalOperation(db,{ operationId:'op-1', request:{ value:1 }, execute })).toEqual({ replayed:true,revision:1,result:{ status:'applied' } });
      expect(executions).toBe(1);
      await expect(runLocalOperation(db,{ operationId:'op-1', request:{ value:2 }, execute })).rejects.toBeInstanceOf(OperationPayloadMismatchError);
      expect((await db.execute('SELECT revision FROM dataset_state')).rows).toEqual([{ revision:1 }]);
    } finally { db.close(); }
  });

  it('rolls back the entity and metadata when execution fails', async () => {
    const db=await openMigratedDatabase({ name:'test.sqlite', location:dir });
    try {
      await expect(runLocalOperation(db,{ operationId:'op-fail',request:{},execute:async(tx)=>{
        await tx.execute("INSERT INTO lists (id,title,rev,created_at,updated_at) VALUES ('l','x',1,'t','t')");
        throw new Error('simulated crash');
      }})).rejects.toThrow('simulated crash');
      expect((await db.execute('SELECT * FROM lists')).rows).toEqual([]);
      expect((await db.execute('SELECT revision FROM dataset_state')).rows).toEqual([{ revision:0 }]);
      expect((await db.execute('SELECT * FROM mutation_journal')).rows).toEqual([]);
      expect((await db.execute('SELECT * FROM applied_operations')).rows).toEqual([]);
    } finally { db.close(); }
  });

  it('replays the persisted result after the database is closed and reopened',async()=>{
    let db=await openMigratedDatabase({ name:'test.sqlite',location:dir });
    await runLocalOperation(db,{ operationId:'durable-op',request:{ id:'n' },execute:async()=>({
      result:{ status:'applied',message:'готово' },events:[{ entityType:'note',entityId:'n',mutation:'delete' }],
    })});
    db.close();
    db=await openMigratedDatabase({ name:'test.sqlite',location:dir });
    try {
      const replay=await runLocalOperation(db,{ operationId:'durable-op',request:{ id:'n' },execute:async()=>{
        throw new Error('must not execute after restart');
      }});
      expect(replay).toEqual({ replayed:true,revision:1,result:{ message:'готово',status:'applied' } });
    } finally { db.close(); }
  });
});
