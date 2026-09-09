import type { OpSqliteDb } from '../db/connection';
import { generateId, nowIso } from './id';
import { markDirty } from './syncOutbox';

export interface List {
  id: string;
  title: string;
  rev: number;
  createdAt: string;
  updatedAt: string;
}

export interface ListItem {
  id: string;
  listId: string;
  text: string;
  checked: boolean;
  rev: number;
  createdAt: string;
  updatedAt: string;
}

interface ListRow {
  id: string;
  title: string;
  rev: number;
  created_at: string;
  updated_at: string;
}

interface ListItemRow {
  id: string;
  list_id: string;
  text: string;
  checked: number;
  rev: number;
  created_at: string;
  updated_at: string;
}

function toList(row: ListRow): List {
  return { id: row.id, title: row.title, rev: row.rev, createdAt: row.created_at, updatedAt: row.updated_at };
}

function toListItem(row: ListItemRow): ListItem {
  return {
    id: row.id,
    listId: row.list_id,
    text: row.text,
    checked: row.checked === 1,
    rev: row.rev,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createList(db: OpSqliteDb, title: string, options?: { id?: string }): Promise<List> {
  const id = options?.id ?? generateId();
  const timestamp = nowIso();
  await db.transaction(async (tx) => {
    await tx.execute('INSERT INTO lists (id, title, rev, created_at, updated_at) VALUES (?, ?, 1, ?, ?)', [
      id,
      title,
      timestamp,
      timestamp,
    ]);
    await markDirty(tx as unknown as OpSqliteDb, 'list', id, false);
  });
  return { id, title, rev: 1, createdAt: timestamp, updatedAt: timestamp };
}

export async function deleteList(db: OpSqliteDb, id: string): Promise<void> {
  // Cascades to items, deliberately unlike deleteClass -- a list's items
  // aren't meaningful without the list, whereas a class is just a label.
  // Each item's own tombstone (from a prior deleteListItem call, or one
  // this function would need to write per item) is deliberately NOT
  // written here for items that were never individually deleted --
  // Key Fob/cloud-platform's own DELETE /yunote/sync/lists/:id already
  // cascades the same way server-side (yunoteSyncStore.deleteList), so
  // one tombstone for the list is sufficient; the items simply vanish
  // from both sides without needing their own delete messages.
  const { rows } = await db.execute('SELECT id FROM list_items WHERE list_id = ?', [id]);
  await db.transaction(async (tx) => {
    await tx.execute('DELETE FROM list_items WHERE list_id = ?', [id]);
    await tx.execute('DELETE FROM lists WHERE id = ?', [id]);
    await markDirty(tx as unknown as OpSqliteDb, 'list', id, true);
    for (const row of (rows ?? []) as { id: string }[]) {
      // Remove any outbox entry the deleted items already had queued --
      // there's nothing left to push for them now that the whole list is
      // gone, and leaving a stale non-deleted entry would make the next
      // flush try to sync an item whose list no longer exists.
      await tx.execute('DELETE FROM sync_outbox WHERE entity_type = ? AND entity_id = ?', ['listItem', row.id]);
    }
  });
}

export async function listLists(db: OpSqliteDb): Promise<List[]> {
  const { rows } = await db.execute('SELECT * FROM lists ORDER BY updated_at DESC');
  return ((rows ?? []) as unknown as ListRow[]).map(toList);
}

export async function addListItem(
  db: OpSqliteDb,
  listId: string,
  text: string,
  options?: { id?: string },
): Promise<ListItem> {
  const id = options?.id ?? generateId();
  const timestamp = nowIso();
  await db.transaction(async (tx) => {
    await tx.execute(
      'INSERT INTO list_items (id, list_id, text, checked, rev, created_at, updated_at) VALUES (?, ?, ?, 0, 1, ?, ?)',
      [id, listId, text, timestamp, timestamp],
    );
    await markDirty(tx as unknown as OpSqliteDb, 'listItem', id, false);
  });
  return { id, listId, text, checked: false, rev: 1, createdAt: timestamp, updatedAt: timestamp };
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
    rev: existing.rev + 1,
    updatedAt: nowIso(),
  };

  await db.transaction(async (tx) => {
    await tx.execute('UPDATE list_items SET text = ?, checked = ?, rev = ?, updated_at = ? WHERE id = ?', [
      next.text,
      next.checked ? 1 : 0,
      next.rev,
      next.updatedAt,
      id,
    ]);
    await markDirty(tx as unknown as OpSqliteDb, 'listItem', id, false);
  });

  return next;
}

export async function deleteListItem(db: OpSqliteDb, id: string): Promise<void> {
  const { rows } = await db.execute('SELECT id FROM list_items WHERE id = ?', [id]);
  if (!rows || rows.length === 0) {
    throw new Error(`List item not found: ${id}`);
  }
  await db.transaction(async (tx) => {
    await tx.execute('DELETE FROM list_items WHERE id = ?', [id]);
    await markDirty(tx as unknown as OpSqliteDb, 'listItem', id, true);
  });
}

export async function listItemsForList(db: OpSqliteDb, listId: string): Promise<ListItem[]> {
  const { rows } = await db.execute('SELECT * FROM list_items WHERE list_id = ? ORDER BY created_at ASC', [listId]);
  return ((rows ?? []) as unknown as ListItemRow[]).map(toListItem);
}
