import type { OpSqliteDb, OpSqliteExecutor } from '../db/connection';
import { generateId, nowIso } from './id';
import { runLocalOnlyTransaction, runLocalOperation, type JournalEvent } from './localOperation';
import { updateNoteInTransaction, type Note } from './notes';

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

async function touchClassInTransaction(tx: OpSqliteExecutor, classId: string): Promise<JournalEvent[]> {
  const { rows } = await tx.execute('SELECT * FROM classes WHERE id=?', [classId]);
  if (!rows?.[0]) throw new Error(`Class not found: ${classId}`);
  const existing = toClass(rows[0] as unknown as ClassRow);
  const klass: Class = { ...existing, rev: existing.rev + 1, updatedAt: nowIso() };
  await tx.execute('UPDATE classes SET rev=?,updated_at=? WHERE id=?', [klass.rev, klass.updatedAt, classId]);
  return [{ entityType: 'class', entityId: classId, mutation: 'upsert', payload: klass }];
}

// Called after any operation that can reduce a class's membership, from both
// the "remove to root" and "delete note" paths, so the ≥2-member invariant
// holds regardless of how membership shrank. Returns the events its own
// writes produced (a note-unwrap event, a class delete/touch event, or
// nothing) -- callers splice these into their own combined events array.
export async function dissolveClassIfNeededInTransaction(tx: OpSqliteExecutor, classId: string): Promise<JournalEvent[]> {
  const { rows } = await tx.execute('SELECT id FROM notes WHERE class_id=?', [classId]);
  const remaining = (rows ?? []) as unknown as { id: string }[];
  if (remaining.length >= 2) return touchClassInTransaction(tx, classId);
  const events: JournalEvent[] = [];
  if (remaining.length === 1) {
    const unwrapped = await updateNoteInTransaction(tx, remaining[0].id, { classId: null });
    events.push(...unwrapped.events);
  }
  await tx.execute('DELETE FROM classes WHERE id=?', [classId]);
  events.push({ entityType: 'class', entityId: classId, mutation: 'delete' });
  return events;
}

export async function createClassFromNotes(db: OpSqliteDb, input: { noteAId: string; noteBId: string }): Promise<Class> {
  if (input.noteAId === input.noteBId) throw new Error('Cannot create a class from a note and itself');
  const id = generateId();
  const outcome = await runLocalOperation(db, {
    operationId: generateId(),
    request: { action: 'createClassFromNotes', id, noteAId: input.noteAId, noteBId: input.noteBId },
    execute: async (tx) => {
      const { rows: rowsA } = await tx.execute('SELECT class_id FROM notes WHERE id=?', [input.noteAId]);
      const { rows: rowsB } = await tx.execute('SELECT class_id FROM notes WHERE id=?', [input.noteBId]);
      if (!rowsA?.[0] || !rowsB?.[0]) throw new Error('One or both notes no longer exist');
      const classIdA = (rowsA[0] as unknown as { class_id: string | null }).class_id;
      const classIdB = (rowsB[0] as unknown as { class_id: string | null }).class_id;
      if (classIdA !== null || classIdB !== null) throw new Error('One or both notes already belongs to a class');
      const created = await createClassInTransaction(tx, { id, name: 'Новый класс' });
      const updatedA = await updateNoteInTransaction(tx, input.noteAId, { classId: id });
      const updatedB = await updateNoteInTransaction(tx, input.noteBId, { classId: id });
      return { result: created.klass, events: [...created.events, ...updatedA.events, ...updatedB.events] };
    },
  });
  return outcome.result;
}

export async function addNoteToClass(db: OpSqliteDb, input: { noteId: string; classId: string }): Promise<Note> {
  const outcome = await runLocalOperation(db, {
    operationId: generateId(),
    request: { action: 'addNoteToClass', noteId: input.noteId, classId: input.classId },
    execute: async (tx) => {
      const { rows: noteRows } = await tx.execute('SELECT class_id FROM notes WHERE id=?', [input.noteId]);
      if (!noteRows?.[0]) throw new Error(`Note not found: ${input.noteId}`);
      const currentClassId = (noteRows[0] as unknown as { class_id: string | null }).class_id;
      if (currentClassId !== null) throw new Error(`Note ${input.noteId} already belongs to a class`);
      const { rows: classRows } = await tx.execute('SELECT id FROM classes WHERE id=?', [input.classId]);
      if (!classRows?.[0]) throw new Error(`Class not found: ${input.classId}`);
      const updated = await updateNoteInTransaction(tx, input.noteId, { classId: input.classId });
      const touched = await touchClassInTransaction(tx, input.classId);
      return { result: updated.note, events: [...updated.events, ...touched] };
    },
  });
  return outcome.result;
}

export async function removeNoteFromClass(db: OpSqliteDb, noteId: string): Promise<Note> {
  const outcome = await runLocalOperation(db, {
    operationId: generateId(),
    request: { action: 'removeNoteFromClass', noteId },
    execute: async (tx) => {
      const { rows } = await tx.execute('SELECT class_id FROM notes WHERE id=?', [noteId]);
      if (!rows?.[0]) throw new Error(`Note not found: ${noteId}`);
      const classId = (rows[0] as unknown as { class_id: string | null }).class_id;
      if (classId === null) throw new Error(`Note ${noteId} is not in a class`);
      const updated = await updateNoteInTransaction(tx, noteId, { classId: null });
      const dissolveEvents = await dissolveClassIfNeededInTransaction(tx, classId);
      return { result: updated.note, events: [...updated.events, ...dissolveEvents] };
    },
  });
  return outcome.result;
}

export async function listClassNoteCounts(db: OpSqliteDb): Promise<Record<string, number>> {
  const { rows } = await db.execute('SELECT class_id, COUNT(*) as count FROM notes WHERE class_id IS NOT NULL GROUP BY class_id');
  const counts: Record<string, number> = {};
  for (const row of (rows ?? []) as unknown as { class_id: string; count: number }[]) {
    counts[row.class_id] = row.count;
  }
  return counts;
}

export async function listClasses(db: OpSqliteDb): Promise<Class[]> {
  const { rows } = await db.execute('SELECT * FROM classes ORDER BY name');
  return ((rows ?? []) as unknown as ClassRow[]).map(toClass);
}
