import type { OpSqliteDb } from '../db/connection';
import { generateId, nowIso } from './id';

export interface List {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface ListItem {
  id: string;
  listId: string;
  text: string;
  checked: boolean;
  createdAt: string;
  updatedAt: string;
}

interface ListRow {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

interface ListItemRow {
  id: string;
  list_id: string;
  text: string;
  checked: number;
  created_at: string;
  updated_at: string;
}

function toList(row: ListRow): List {
  return { id: row.id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at };
}

function toListItem(row: ListItemRow): ListItem {
  return {
    id: row.id,
    listId: row.list_id,
    text: row.text,
    checked: row.checked === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createList(db: OpSqliteDb, title: string): Promise<List> {
  const id = generateId();
  const timestamp = nowIso();
  await db.execute('INSERT INTO lists (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)', [
    id,
    title,
    timestamp,
    timestamp,
  ]);
  return { id, title, createdAt: timestamp, updatedAt: timestamp };
}

export async function deleteList(db: OpSqliteDb, id: string): Promise<void> {
  // Cascades to items, deliberately unlike deleteClass -- a list's items
  // aren't meaningful without the list, whereas a class is just a label.
  await db.execute('DELETE FROM list_items WHERE list_id = ?', [id]);
  await db.execute('DELETE FROM lists WHERE id = ?', [id]);
}

export async function listLists(db: OpSqliteDb): Promise<List[]> {
  const { rows } = await db.execute('SELECT * FROM lists ORDER BY updated_at DESC');
  return ((rows ?? []) as unknown as ListRow[]).map(toList);
}

export async function addListItem(db: OpSqliteDb, listId: string, text: string): Promise<ListItem> {
  const id = generateId();
  const timestamp = nowIso();
  await db.execute(
    'INSERT INTO list_items (id, list_id, text, checked, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)',
    [id, listId, text, timestamp, timestamp],
  );
  return { id, listId, text, checked: false, createdAt: timestamp, updatedAt: timestamp };
}

export async function updateListItem(
  db: OpSqliteDb,
  id: string,
  patch: Partial<{ text: string; checked: boolean }>,
): Promise<ListItem> {
  const { rows } = await db.execute('SELECT * FROM list_items WHERE id = ?', [id]);
  const existing = toListItem((rows as unknown as ListItemRow[])[0]);

  const next: ListItem = {
    ...existing,
    ...(patch.text !== undefined ? { text: patch.text } : {}),
    ...(patch.checked !== undefined ? { checked: patch.checked } : {}),
    updatedAt: nowIso(),
  };

  await db.execute('UPDATE list_items SET text = ?, checked = ?, updated_at = ? WHERE id = ?', [
    next.text,
    next.checked ? 1 : 0,
    next.updatedAt,
    id,
  ]);

  return next;
}

export async function deleteListItem(db: OpSqliteDb, id: string): Promise<void> {
  await db.execute('DELETE FROM list_items WHERE id = ?', [id]);
}

export async function listItemsForList(db: OpSqliteDb, listId: string): Promise<ListItem[]> {
  const { rows } = await db.execute('SELECT * FROM list_items WHERE list_id = ? ORDER BY created_at ASC', [listId]);
  return ((rows ?? []) as unknown as ListItemRow[]).map(toListItem);
}
