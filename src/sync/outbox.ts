import type { OpSqliteDb } from '../db/connection';
import type { LocalTransport, LocalTransportMessage } from '../relay/localTransport';
import { generateId } from '../data/id';

interface OutboxRow {
  entity_type: 'note' | 'list' | 'listItem';
  entity_id: string;
  deleted: number;
  transfer_id: string | null;
}

async function loadEntityData(
  db: OpSqliteDb,
  entityType: 'note' | 'list' | 'listItem',
  id: string,
): Promise<Record<string, unknown> | undefined> {
  const table = { note: 'notes', list: 'lists', listItem: 'list_items' }[entityType];
  const { rows } = await db.execute(`SELECT * FROM ${table} WHERE id = ?`, [id]);
  return (rows?.[0] as Record<string, unknown> | undefined) ?? undefined;
}

export async function flushOutbox(db: OpSqliteDb, transport: LocalTransport): Promise<void> {
  const { rows } = await db.execute('SELECT * FROM sync_outbox WHERE transfer_id IS NULL');
  const dirty = (rows ?? []) as unknown as OutboxRow[];
  if (dirty.length === 0) {
    return;
  }

  const entities = await Promise.all(
    dirty.map(async (row) => {
      if (row.deleted === 1) {
        return { entityType: row.entity_type, id: row.entity_id, deleted: true };
      }
      const data = await loadEntityData(db, row.entity_type, row.entity_id);
      return { entityType: row.entity_type, id: row.entity_id, deleted: false, data };
    }),
  );

  const transferId = generateId();
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
          await db.execute(
            `INSERT INTO sync_outbox (entity_type, entity_id, deleted, transfer_id, created_at)
             VALUES (?, ?, 0, NULL, ?)
             ON CONFLICT (entity_type, entity_id) DO UPDATE SET transfer_id = NULL`,
            [entityType, row.id, new Date().toISOString()],
          );
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
      const acknowledged = (message.small?.acknowledged ?? []) as { entityType: string; id: string }[];
      for (const entry of acknowledged) {
        await db.execute('DELETE FROM sync_outbox WHERE entity_type = ? AND entity_id = ?', [
          entry.entityType,
          entry.id,
        ]);
      }
      await transport.acknowledge(message.transferId);
      return;
    }
  });
}
