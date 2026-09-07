import type { OpSqliteDb } from '../db/connection';
import { generateId, nowIso } from './id';

export interface Class {
  id: string;
  name: string;
  createdAt: string;
}

interface ClassRow {
  id: string;
  name: string;
  created_at: string;
}

function toClass(row: ClassRow): Class {
  return { id: row.id, name: row.name, createdAt: row.created_at };
}

export async function createClass(db: OpSqliteDb, name: string): Promise<Class> {
  const id = generateId();
  const createdAt = nowIso();
  await db.execute('INSERT INTO classes (id, name, created_at) VALUES (?, ?, ?)', [id, name, createdAt]);
  return { id, name, createdAt };
}

export async function deleteClass(db: OpSqliteDb, id: string): Promise<void> {
  // Order matters: null out referencing notes before deleting the class row,
  // so a note is never left pointing at a class_id that no longer exists.
  await db.execute('UPDATE notes SET class_id = NULL WHERE class_id = ?', [id]);
  await db.execute('DELETE FROM classes WHERE id = ?', [id]);
}

export async function listClasses(db: OpSqliteDb): Promise<Class[]> {
  const { rows } = await db.execute('SELECT * FROM classes ORDER BY name');
  return ((rows ?? []) as unknown as ClassRow[]).map(toClass);
}
