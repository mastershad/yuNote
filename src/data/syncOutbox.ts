import type { OpSqliteExecutor } from '../db/connection';
import { nowIso } from './id';

// Shared by notes.ts, lists.ts (every local mutation) and outbox.ts's
// `linked` handler (bulk re-marking on pairing) so there is exactly one
// implementation of the sync_outbox upsert, rather than three independently
// maintained copies that can drift from each other.
export async function markDirty(
  db: OpSqliteExecutor,
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
