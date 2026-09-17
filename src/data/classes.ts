import type { OpSqliteDb, OpSqliteExecutor } from '../db/connection';
import { generateId, nowIso } from './id';
import { runLocalOnlyTransaction, type JournalEvent } from './localOperation';

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
  return runLocalOnlyTransaction(db, async (tx) => {
    const created = await createClassInTransaction(tx, { id, name });
    return created.klass;
  });
}

export async function deleteClassInTransaction(tx:OpSqliteExecutor,id:string):Promise<void> {
  const { rows:classRows }=await tx.execute('SELECT id FROM classes WHERE id=?',[id]);
  if (!classRows?.length) throw new Error(`Class not found: ${id}`);
  const { rows:noteRows }=await tx.execute('SELECT id FROM notes WHERE class_id=? LIMIT 1',[id]);
  if (noteRows?.length) throw new Error(`Cannot delete class ${id}: it still has member notes`);
  const { rows:listRows }=await tx.execute('SELECT id FROM lists WHERE class_id=? LIMIT 1',[id]);
  if (listRows?.length) throw new Error(`Cannot delete class ${id}: it still has member lists`);
  await tx.execute('DELETE FROM classes WHERE id=?',[id]);
}

export async function renameClassInTransaction(tx:OpSqliteExecutor,id:string,name:string):Promise<Class> {
  const { rows }=await tx.execute('SELECT * FROM classes WHERE id=?',[id]);
  if (!rows?.[0]) throw new Error(`Class not found: ${id}`);
  const existing=toClass(rows[0] as unknown as ClassRow);
  const klass:Class={ ...existing,name,rev:existing.rev+1,updatedAt:nowIso() };
  await tx.execute('UPDATE classes SET name=?,rev=?,updated_at=? WHERE id=?',[klass.name,klass.rev,klass.updatedAt,id]);
  return klass;
}

export async function renameClass(db: OpSqliteDb, id: string, name: string): Promise<Class> {
  return runLocalOnlyTransaction(db, (tx) => renameClassInTransaction(tx, id, name));
}

export async function deleteClass(db: OpSqliteDb, id: string): Promise<void> {
  await runLocalOnlyTransaction(db, async (tx) => {
    await deleteClassInTransaction(tx, id);
  });
}

export async function listClasses(db: OpSqliteDb): Promise<Class[]> {
  const { rows } = await db.execute('SELECT * FROM classes ORDER BY name');
  return ((rows ?? []) as unknown as ClassRow[]).map(toClass);
}
