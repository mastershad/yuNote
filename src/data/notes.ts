import type { OpSqliteDb, OpSqliteExecutor } from '../db/connection';
import { generateId, nowIso } from './id';
import { markDirty } from './syncOutbox';
import { runLocalOperation, type JournalEvent } from './localOperation';
import { dissolveClassIfNeededInTransaction } from './classes';

export interface Note {
  id: string;
  title: string;
  content: string;
  classId: string | null;
  rev: number;
  createdAt: string;
  updatedAt: string;
  position: number;
}

interface NoteRow {
  id: string;
  title: string;
  content: string;
  class_id: string | null;
  rev: number;
  created_at: string;
  updated_at: string;
  position: number;
}

function toNote(row: NoteRow): Note {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    classId: row.class_id,
    rev: row.rev,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    position: row.position,
  };
}

export async function createNoteInTransaction(
  tx:OpSqliteExecutor,
  input:{ id:string; title:string; content:string; classId:string|null; position?:number },
):Promise<{ note:Note; events:JournalEvent[] }> {
  const timestamp=nowIso();
  const note:Note={ ...input, position:input.position ?? 0, rev:1, createdAt:timestamp, updatedAt:timestamp };
  await tx.execute(
    'INSERT INTO notes (id,title,content,class_id,rev,created_at,updated_at,position) VALUES (?,?,?,?,1,?,?,?)',
    [note.id,note.title,note.content,note.classId,timestamp,timestamp,note.position],
  );
  await markDirty(tx,'note',note.id,false);
  return { note,events:[{ entityType:'note',entityId:note.id,mutation:'upsert',payload:note }] };
}

export async function createNote(
  db: OpSqliteDb,
  input: { title: string; content: string; classId?: string; id?: string },
): Promise<Note> {
  const id = input.id ?? generateId();
  const classId = input.classId ?? null;
  const outcome=await runLocalOperation(db,{ operationId:generateId(),request:{ action:'createNote',id,title:input.title,content:input.content,classId },execute:async(tx)=>{
    const created=await createNoteInTransaction(tx,{ id,title:input.title,content:input.content,classId });
    return { result:created.note,events:created.events };
  }});
  return outcome.result;
}

export async function updateNoteInTransaction(
  tx:OpSqliteExecutor,id:string,patch:Partial<{ title:string;content:string;classId:string|null;position:number }>,
):Promise<{ note:Note;events:JournalEvent[] }> {
  const { rows }=await tx.execute('SELECT * FROM notes WHERE id = ?',[id]);
  if (!rows?.[0]) throw new Error(`Note not found: ${id}`);
  const existing=toNote(rows[0] as unknown as NoteRow);
  const note:Note={ ...existing,...(patch.title!==undefined?{title:patch.title}:{}),...(patch.content!==undefined?{content:patch.content}:{}),
    ...(patch.classId!==undefined?{classId:patch.classId}:{}),...(patch.position!==undefined?{position:patch.position}:{}),rev:existing.rev+1,updatedAt:nowIso() };
  await tx.execute('UPDATE notes SET title=?,content=?,class_id=?,rev=?,updated_at=?,position=? WHERE id=?',
    [note.title,note.content,note.classId,note.rev,note.updatedAt,note.position,id]);
  await markDirty(tx,'note',id,false);
  return { note,events:[{ entityType:'note',entityId:id,mutation:'upsert',payload:note }] };
}

export async function updateNote(
  db: OpSqliteDb,
  id: string,
  patch: Partial<{ title: string; content: string; classId: string | null }>,
): Promise<Note> {
  const outcome=await runLocalOperation(db,{ operationId:generateId(),request:{ action:'updateNote',id,patch },execute:async(tx)=>{
    const updated=await updateNoteInTransaction(tx,id,patch);
    return { result:updated.note,events:updated.events };
  }});
  return outcome.result;
}

export async function deleteNoteInTransaction(tx:OpSqliteExecutor,id:string):Promise<JournalEvent[]> {
  const { rows }=await tx.execute('SELECT class_id FROM notes WHERE id=?',[id]);
  if (!rows?.length) throw new Error(`Note not found: ${id}`);
  const classId=(rows[0] as unknown as { class_id:string|null }).class_id;
  await tx.execute('DELETE FROM notes WHERE id=?',[id]);
  await markDirty(tx,'note',id,true);
  const events:JournalEvent[]=[{ entityType:'note', entityId:id, mutation:'delete' }];
  if (classId!==null) events.push(...await dissolveClassIfNeededInTransaction(tx,classId));
  return events;
}

export async function deleteNote(db: OpSqliteDb, id: string): Promise<void> {
  await runLocalOperation(db,{ operationId:generateId(),request:{ action:'deleteNote',id },execute:async(tx)=>{
    const events=await deleteNoteInTransaction(tx,id);
    return { result:{ status:'deleted' },events };
  }});
}

export async function listNotes(
  db: OpSqliteDb,
  options: { classId?: string | null; sort: 'date-desc' | 'date-asc' | 'title-asc' | 'title-desc' },
): Promise<Note[]> {
  const orderBy = {
    'date-desc': 'updated_at DESC',
    'date-asc': 'updated_at ASC',
    'title-asc': 'title ASC',
    'title-desc': 'title DESC',
  }[options.sort];

  if (options.classId === undefined) {
    const { rows } = await db.execute(`SELECT * FROM notes ORDER BY ${orderBy}`);
    return ((rows ?? []) as unknown as NoteRow[]).map(toNote);
  }

  if (options.classId === null) {
    const { rows } = await db.execute(`SELECT * FROM notes WHERE class_id IS NULL ORDER BY ${orderBy}`);
    return ((rows ?? []) as unknown as NoteRow[]).map(toNote);
  }

  const { rows } = await db.execute(`SELECT * FROM notes WHERE class_id = ? ORDER BY ${orderBy}`, [options.classId]);
  return ((rows ?? []) as unknown as NoteRow[]).map(toNote);
}
