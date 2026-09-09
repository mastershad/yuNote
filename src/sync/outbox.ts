import type { OpSqliteDb } from '../db/connection';
import type { LocalTransport, LocalTransportMessage } from '../relay/localTransport';
import { generateId } from '../data/id';
import { markDirty } from '../data/syncOutbox';

interface OutboxRow {
  entity_type: 'note' | 'list' | 'listItem';
  entity_id: string;
  deleted: number;
  transfer_id: string | null;
}

// The camelCase DTO shape pushed for each dirty entity -- deliberately NOT a
// raw `SELECT *` row. Excludes class_id (a class row must never leave the
// device, see src/db/connection.ts:39-43) and synced_at (always NULL,
// meaningless to any receiver).
export interface SyncPushEntity {
  entityType: 'note' | 'list' | 'listItem';
  id: string;
  deleted: boolean;
  data?: Record<string, unknown>;
}

interface NoteDataRow {
  id: string;
  title: string;
  content: string;
  created_at: string;
  updated_at: string;
  rev: number;
}

interface ListDataRow {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  rev: number;
}

interface ListItemDataRow {
  id: string;
  list_id: string;
  text: string;
  checked: number;
  created_at: string;
  updated_at: string;
  rev: number;
}

async function loadEntityData(
  db: OpSqliteDb,
  entityType: 'note' | 'list' | 'listItem',
  id: string,
): Promise<Record<string, unknown> | undefined> {
  if (entityType === 'note') {
    const { rows } = await db.execute(
      'SELECT id, title, content, created_at, updated_at, rev FROM notes WHERE id = ?',
      [id],
    );
    const row = rows?.[0] as NoteDataRow | undefined;
    if (!row) {
      return undefined;
    }
    return {
      id: row.id,
      title: row.title,
      content: row.content,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      rev: row.rev,
    };
  }

  if (entityType === 'list') {
    const { rows } = await db.execute('SELECT id, title, created_at, updated_at, rev FROM lists WHERE id = ?', [id]);
    const row = rows?.[0] as ListDataRow | undefined;
    if (!row) {
      return undefined;
    }
    return {
      id: row.id,
      title: row.title,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      rev: row.rev,
    };
  }

  const { rows } = await db.execute(
    'SELECT id, list_id, text, checked, created_at, updated_at, rev FROM list_items WHERE id = ?',
    [id],
  );
  const row = rows?.[0] as ListItemDataRow | undefined;
  if (!row) {
    return undefined;
  }
  return {
    id: row.id,
    listId: row.list_id,
    text: row.text,
    checked: row.checked === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    rev: row.rev,
  };
}

export async function flushOutbox(db: OpSqliteDb, transport: LocalTransport): Promise<void> {
  const { rows } = await db.execute('SELECT * FROM sync_outbox WHERE transfer_id IS NULL');
  const dirty = (rows ?? []) as unknown as OutboxRow[];
  if (dirty.length === 0) {
    return;
  }

  const entities: SyncPushEntity[] = await Promise.all(
    dirty.map(async (row): Promise<SyncPushEntity> => {
      if (row.deleted === 1) {
        return { entityType: row.entity_type, id: row.entity_id, deleted: true };
      }
      const data = await loadEntityData(db, row.entity_type, row.entity_id);
      return { entityType: row.entity_type, id: row.entity_id, deleted: false, data };
    }),
  );

  const transferId = generateId();
  // Every push currently goes via `small` regardless of payload size -- this
  // repo doesn't yet build a real platform transport adapter capable of
  // writing to a shared file (largeRef), that's Step 3b. Revisit once
  // initial-sync-sized pushes (potentially the entire local DB, per spec
  // §5.2) meet a real adapter's payload limits.
  await transport.send({ transferId, kind: 'sync-push', small: { entities } });

  await db.execute('UPDATE sync_outbox SET transfer_id = ? WHERE transfer_id IS NULL', [transferId]);
}

export function registerSyncHandlers(db: OpSqliteDb, transport: LocalTransport): () => void {
  return transport.onReceive(async (message: LocalTransportMessage) => {
    if (message.kind === 'linked') {
      for (const [entityType, table] of [
        ['note', 'notes'],
        ['list', 'lists'],
        ['listItem', 'list_items'],
      ] as const) {
        const { rows } = await db.execute(`SELECT id FROM ${table}`);
        for (const row of (rows ?? []) as { id: string }[]) {
          await markDirty(db, entityType, row.id, false);
        }
      }
      await transport.acknowledge(message.transferId);
      return;
    }

    if (message.kind === 'unlinked') {
      await db.execute('DELETE FROM sync_outbox');
      await transport.acknowledge(message.transferId);
      return;
    }

    if (message.kind === 'sync-ack') {
      // Each acknowledged entry carries the transferId of the *push* it is
      // acknowledging (distinct from this ack message's own top-level
      // message.transferId, which is the ack's own transport-level id, used
      // below for transport.acknowledge). Scoping the delete to that
      // transferId is what makes this self-correcting against the race
      // where the entity was edited again (resetting transfer_id to NULL
      // via markDirty) after being pushed but before this ack arrives: the
      // scoped delete then simply won't match, and the row survives,
      // correctly dirty, ready for the next flushOutbox.
      const acknowledged = (message.small?.acknowledged ?? []) as {
        entityType: string;
        id: string;
        transferId: string;
      }[];
      for (const entry of acknowledged) {
        await db.execute(
          'DELETE FROM sync_outbox WHERE entity_type = ? AND entity_id = ? AND transfer_id = ?',
          [entry.entityType, entry.id, entry.transferId],
        );
      }
      await transport.acknowledge(message.transferId);
      return;
    }
  });
}
