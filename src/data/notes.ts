import type { OpSqliteDb } from '../db/connection';
import { generateId, nowIso } from './id';

export interface Note {
  id: string;
  title: string;
  content: string;
  classId: string | null;
  rev: number;
  createdAt: string;
  updatedAt: string;
}

interface NoteRow {
  id: string;
  title: string;
  content: string;
  class_id: string | null;
  rev: number;
  created_at: string;
  updated_at: string;
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
  };
}

async function markDirty(
  db: OpSqliteDb,
  entityType: 'note' | 'list' | 'listItem',
  entityId: string,
  deleted: boolean,
): Promise<void> {
  await db.execute(
    `INSERT INTO sync_outbox (entity_type, entity_id, deleted, transfer_id, created_at)
     VALUES (?, ?, ?, NULL, ?)
     ON CONFLICT (entity_type, entity_id) DO UPDATE SET
       deleted = excluded.deleted, transfer_id = NULL, created_at = excluded.created_at`,
    [entityType, entityId, deleted ? 1 : 0, nowIso()],
  );
}

export async function createNote(
  db: OpSqliteDb,
  input: { title: string; content: string; classId?: string; id?: string },
): Promise<Note> {
  const id = input.id ?? generateId();
  const timestamp = nowIso();
  const classId = input.classId ?? null;
  await db.transaction(async (tx) => {
    await tx.execute(
      'INSERT INTO notes (id, title, content, class_id, rev, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)',
      [id, input.title, input.content, classId, timestamp, timestamp],
    );
    await markDirty(tx as unknown as OpSqliteDb, 'note', id, false);
  });
  return { id, title: input.title, content: input.content, classId, rev: 1, createdAt: timestamp, updatedAt: timestamp };
}

export async function updateNote(
  db: OpSqliteDb,
  id: string,
  patch: Partial<{ title: string; content: string; classId: string | null }>,
): Promise<Note> {
  const { rows } = await db.execute('SELECT * FROM notes WHERE id = ?', [id]);
  const existing = toNote((rows as unknown as NoteRow[])[0]);

  const next: Note = {
    ...existing,
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.content !== undefined ? { content: patch.content } : {}),
    ...(patch.classId !== undefined ? { classId: patch.classId } : {}),
    rev: existing.rev + 1,
    updatedAt: nowIso(),
  };

  await db.transaction(async (tx) => {
    await tx.execute(
      'UPDATE notes SET title = ?, content = ?, class_id = ?, rev = ?, updated_at = ? WHERE id = ?',
      [next.title, next.content, next.classId, next.rev, next.updatedAt, id],
    );
    await markDirty(tx as unknown as OpSqliteDb, 'note', id, false);
  });

  return next;
}

export async function deleteNote(db: OpSqliteDb, id: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute('DELETE FROM notes WHERE id = ?', [id]);
    await markDirty(tx as unknown as OpSqliteDb, 'note', id, true);
  });
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
