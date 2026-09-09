import { openMigratedDatabase, type OpSqliteDb } from '../../src/db/connection';
import { flushOutbox, registerSyncHandlers } from '../../src/sync/outbox';
import { createInMemoryLocalTransport } from '../../src/relay/inMemoryLocalTransport';
import { createNote, deleteNote } from '../../src/data/notes';
import { createList, addListItem } from '../../src/data/lists';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('flushOutbox', () => {
  let dir: string;
  let db: OpSqliteDb;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'yunote-outbox-test-'));
    db = await openMigratedDatabase({ name: 'test.sqlite', location: dir });
  });

  afterEach(() => {
    try {
      db?.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sends one sync-push message carrying every dirty entity', async () => {
    const note = await createNote(db, { title: 'Идея', content: 'текст' });
    const list = await createList(db, 'Покупки');
    const transport = createInMemoryLocalTransport();

    await flushOutbox(db, transport);

    expect(transport.sentMessages).toHaveLength(1);
    const [message] = transport.sentMessages;
    expect(message.kind).toBe('sync-push');
    const entities = (message.small?.entities ?? []) as { entityType: string; id: string }[];
    expect(entities.map((e) => e.id).sort()).toEqual([list.id, note.id].sort());
  });

  it('a deleted entity is sent as a tombstone (deleted: true, no data)', async () => {
    const note = await createNote(db, { title: 'Идея', content: 'текст' });
    await deleteNote(db, note.id);
    const transport = createInMemoryLocalTransport();

    await flushOutbox(db, transport);

    const [message] = transport.sentMessages;
    const entities = (message.small?.entities ?? []) as { id: string; deleted: boolean; data?: unknown }[];
    expect(entities).toEqual([{ entityType: 'note', id: note.id, deleted: true }]);
  });

  it('does nothing (sends no message) when sync_outbox is empty', async () => {
    const transport = createInMemoryLocalTransport();

    await flushOutbox(db, transport);

    expect(transport.sentMessages).toEqual([]);
  });

  it('a row already stamped with a transfer_id (already sent, awaiting ack) is not sent again', async () => {
    await createNote(db, { title: 'Идея', content: 'текст' });
    const transport = createInMemoryLocalTransport();
    await flushOutbox(db, transport);
    expect(transport.sentMessages).toHaveLength(1);

    await flushOutbox(db, transport);

    expect(transport.sentMessages).toHaveLength(1);
  });

  it('a new dirty entity created after a flush is included in the next flush', async () => {
    const transport = createInMemoryLocalTransport();
    await createNote(db, { title: 'A', content: '' });
    await flushOutbox(db, transport);

    const secondNote = await createNote(db, { title: 'B', content: '' });
    await flushOutbox(db, transport);

    expect(transport.sentMessages).toHaveLength(2);
    const secondEntities = (transport.sentMessages[1].small?.entities ?? []) as { id: string }[];
    expect(secondEntities.map((e) => e.id)).toEqual([secondNote.id]);
  });
});

describe('registerSyncHandlers', () => {
  let dir: string;
  let db: OpSqliteDb;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'yunote-sync-handlers-test-'));
    db = await openMigratedDatabase({ name: 'test.sqlite', location: dir });
  });

  afterEach(() => {
    try {
      db?.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('linked marks every existing note/list/list_item dirty', async () => {
    // Simulate pre-existing local data that predates pairing: clear the
    // outbox entries createNote/createList/addListItem already wrote, so
    // this test genuinely proves 'linked' re-marks them, not that they
    // were already dirty from creation.
    const note = await createNote(db, { title: 'Идея', content: 'текст' });
    const list = await createList(db, 'Покупки');
    const item = await addListItem(db, list.id, 'Молоко');
    await db.execute('DELETE FROM sync_outbox');

    const transport = createInMemoryLocalTransport();
    registerSyncHandlers(db, transport);
    await transport.simulateReceive({ transferId: 't-linked', kind: 'linked', small: { linkedAt: '2026-09-09T00:00:00.000Z' } });

    const { rows } = await db.execute('SELECT entity_id FROM sync_outbox ORDER BY entity_id');
    expect(rows?.map((r) => r.entity_id).sort()).toEqual([item.id, list.id, note.id].sort());
  });

  it('unlinked clears sync_outbox but leaves notes/lists/list_items untouched', async () => {
    const note = await createNote(db, { title: 'Идея', content: 'текст' });
    const transport = createInMemoryLocalTransport();
    registerSyncHandlers(db, transport);

    await transport.simulateReceive({ transferId: 't-unlinked', kind: 'unlinked', small: {} });

    const { rows: outboxRows } = await db.execute('SELECT * FROM sync_outbox');
    expect(outboxRows).toEqual([]);
    const { rows: noteRows } = await db.execute('SELECT id FROM notes WHERE id = ?', [note.id]);
    expect(noteRows).toHaveLength(1);
  });

  it('sync-ack clears exactly the outbox rows named in its payload, leaving others untouched', async () => {
    const noteA = await createNote(db, { title: 'A', content: '' });
    const noteB = await createNote(db, { title: 'B', content: '' });
    const transport = createInMemoryLocalTransport();
    registerSyncHandlers(db, transport);

    await transport.simulateReceive({
      transferId: 't-ack',
      kind: 'sync-ack',
      small: { acknowledged: [{ entityType: 'note', id: noteA.id }] },
    });

    const { rows } = await db.execute('SELECT entity_id FROM sync_outbox');
    expect(rows?.map((r) => r.entity_id)).toEqual([noteB.id]);
  });
});
