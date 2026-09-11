import type { OpSqliteDb, OpSqliteExecutor } from '../db/connection';
import { generateId, nowIso } from './id';
import { runLocalOperation, type JournalEvent } from './localOperation';
import { updateNoteInTransaction } from './notes';
import { updateListInTransaction } from './lists';

export interface Class {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  rev:number;
  position:number;
}

interface ClassRow {
  id: string;
  name: string;
  created_at: string;
  updated_at:string;
  rev:number;
  position:number;
}

function toClass(row: ClassRow): Class {
  return { id:row.id,name:row.name,createdAt:row.created_at,updatedAt:row.updated_at,rev:row.rev,position:row.position };
}

export async function createClassInTransaction(tx:OpSqliteExecutor,input:{ id:string;name:string;position?:number }):Promise<{ klass:Class;events:JournalEvent[] }> {
  const timestamp=nowIso();
  const klass:Class={ id:input.id,name:input.name,createdAt:timestamp,updatedAt:timestamp,rev:1,position:input.position ?? 0 };
  await tx.execute('INSERT INTO classes (id,name,created_at,updated_at,rev,position) VALUES (?,?,?,?,?,?)',
    [klass.id,klass.name,klass.createdAt,klass.updatedAt,klass.rev,klass.position]);
  return { klass,events:[{ entityType:'class',entityId:klass.id,mutation:'upsert',payload:klass }] };
}

export async function createClass(db: OpSqliteDb, name: string): Promise<Class> {
  const id = generateId();
  const outcome=await runLocalOperation(db,{ operationId:generateId(),request:{ action:'createClass',id,name },execute:async(tx)=>{
    const created=await createClassInTransaction(tx,{ id,name });
    return { result:created.klass,events:created.events };
  }});
  return outcome.result;
}

export async function deleteClassInTransaction(tx:OpSqliteExecutor,id:string):Promise<JournalEvent[]> {
  const { rows:classRows }=await tx.execute('SELECT id FROM classes WHERE id=?',[id]);
  if (!classRows?.length) throw new Error(`Class not found: ${id}`);
  const { rows:noteRows }=await tx.execute('SELECT id FROM notes WHERE class_id=? ORDER BY id',[id]);
  const events:JournalEvent[]=[];
  for (const row of (noteRows ?? []) as { id:string }[]) {
    const updated=await updateNoteInTransaction(tx,row.id,{ classId:null });
    events.push(...updated.events);
  }
  const { rows:listRows }=await tx.execute('SELECT id FROM lists WHERE class_id=? ORDER BY id',[id]);
  for (const row of (listRows ?? []) as { id:string }[]) {
    const updated=await updateListInTransaction(tx,row.id,{ classId:null });
    events.push(...updated.events);
  }
  await tx.execute('DELETE FROM classes WHERE id=?',[id]);
  events.push({ entityType:'class',entityId:id,mutation:'delete' });
  return events;
}

export async function deleteClass(db: OpSqliteDb, id: string): Promise<void> {
  await runLocalOperation(db,{ operationId:generateId(),request:{ action:'deleteClass',id },execute:async(tx)=>({
    result:{ status:'deleted' },events:await deleteClassInTransaction(tx,id),
  })});
}

export async function listClasses(db: OpSqliteDb): Promise<Class[]> {
  const { rows } = await db.execute('SELECT * FROM classes ORDER BY name');
  return ((rows ?? []) as unknown as ClassRow[]).map(toClass);
}
