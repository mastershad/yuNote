import { openMigratedDatabase, type OpSqliteDb } from '../../src/db/connection';
import { applyStructuredAction, registerActionDispatcher } from '../../src/relay/actionDispatcher';
import { createInMemoryLocalTransport } from '../../src/relay/inMemoryLocalTransport';
import { createNote } from '../../src/data/notes';
import { createList, addListItem, listItemsForList } from '../../src/data/lists';
import { listNotes } from '../../src/data/notes';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('applyStructuredAction', () => {
  let dir: string;
  let db: OpSqliteDb;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'yunote-dispatcher-test-'));
    db = await openMigratedDatabase({ name: 'test.sqlite', location: dir });
  });

  afterEach(() => {
    try {
      db?.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Capture on a note creates it at the server-provided id, with title and content', async () => {
    const result = await applyStructuredAction(db, {
      verb: 'Capture',
      targetType: 'note',
      targetId: 'yn-server-note-1',
      title: 'Идея',
      content: 'Купить билеты',
    });

    expect(result).toEqual({ status: 'applied' });
    const notes = await listNotes(db, { sort: 'date-desc' });
    expect(notes).toEqual([expect.objectContaining({ id: 'yn-server-note-1', title: 'Идея', content: 'Купить билеты' })]);
  });

  it('Modify on a note updates its content, leaving title unchanged', async () => {
    const note = await createNote(db, { title: 'Идея', content: 'старый текст' });

    const result = await applyStructuredAction(db, {
      verb: 'Modify',
      targetType: 'note',
      targetId: note.id,
      content: 'новый текст',
    });

    expect(result).toEqual({ status: 'applied' });
    const notes = await listNotes(db, { sort: 'date-desc' });
    expect(notes).toEqual([expect.objectContaining({ id: note.id, title: 'Идея', content: 'новый текст' })]);
  });

  it('Remove on a note deletes it', async () => {
    const note = await createNote(db, { title: 'Идея', content: 'текст' });

    const result = await applyStructuredAction(db, { verb: 'Remove', targetType: 'note', targetId: note.id });

    expect(result).toEqual({ status: 'applied' });
    expect(await listNotes(db, { sort: 'date-desc' })).toEqual([]);
  });

  it('Clear on notes deletes every id in targetIds', async () => {
    const noteA = await createNote(db, { title: 'A', content: '' });
    const noteB = await createNote(db, { title: 'B', content: '' });

    const result = await applyStructuredAction(db, {
      verb: 'Clear',
      targetType: 'note',
      targetId: noteA.id,
      targetIds: [noteA.id, noteB.id],
    });

    expect(result).toEqual({ status: 'applied' });
    expect(await listNotes(db, { sort: 'date-desc' })).toEqual([]);
  });

  it('Capture on a listItem with an existing parentListId adds the item to that list', async () => {
    const list = await createList(db, 'Покупки');

    const result = await applyStructuredAction(db, {
      verb: 'Capture',
      targetType: 'listItem',
      targetId: 'yn-server-item-1',
      parentListId: list.id,
      content: 'Молоко',
    });

    expect(result).toEqual({ status: 'applied' });
    const items = await listItemsForList(db, list.id);
    expect(items).toEqual([expect.objectContaining({ id: 'yn-server-item-1', text: 'Молоко' })]);
  });

  it('Capture on a listItem with listName set creates the list first, then the item, using the server ids for both', async () => {
    const result = await applyStructuredAction(db, {
      verb: 'Capture',
      targetType: 'listItem',
      targetId: 'yn-server-item-2',
      parentListId: 'yn-server-list-1',
      listName: 'Отпуск',
      content: 'Солнцезащитный крем',
    });

    expect(result).toEqual({ status: 'applied' });
    const items = await listItemsForList(db, 'yn-server-list-1');
    expect(items).toEqual([expect.objectContaining({ id: 'yn-server-item-2', text: 'Солнцезащитный крем' })]);
    expect((await db.execute('SELECT revision FROM dataset_state')).rows).toEqual([{ revision:1 }]);
    expect((await db.execute('SELECT entity_type FROM mutation_journal ORDER BY sequence')).rows).toEqual([
      { entity_type:'list' },{ entity_type:'listItem' },
    ]);
  });

  it('rolls back an entire Clear when a later target fails',async()=>{
    const noteA=await createNote(db,{ title:'A',content:'' });
    const noteB=await createNote(db,{ title:'B',content:'' });
    const result=await applyStructuredAction(db,{ verb:'Clear',targetType:'note',targetId:noteA.id,targetIds:[noteA.id,'missing'] },'op-clear');
    expect(result.status).toBe('failed');
    expect((await listNotes(db,{ sort:'title-asc' })).map(note=>note.id)).toEqual([noteA.id,noteB.id]);
    expect((await db.execute('SELECT revision FROM dataset_state')).rows).toEqual([{ revision:2 }]);
  });

  it('replays one operationId once and rejects reuse with changed action content',async()=>{
    const action={ verb:'Capture' as const,targetType:'note' as const,targetId:'stable-note',title:'A',content:'same' };
    expect(await applyStructuredAction(db,action,'operation-stable')).toEqual({ status:'applied' });
    expect(await applyStructuredAction(db,action,'operation-stable')).toEqual({ status:'applied' });
    const mismatch=await applyStructuredAction(db,{ ...action,content:'changed' },'operation-stable');
    expect(mismatch).toEqual({ status:'failed',reason:expect.stringContaining('different request') });
    expect((await db.execute('SELECT revision FROM dataset_state')).rows).toEqual([{ revision:1 }]);
    expect(await listNotes(db,{ sort:'date-desc' })).toHaveLength(1);
  });

  it('Modify on a listItem updates its text', async () => {
    const list = await createList(db, 'Покупки');
    const item = await addListItem(db, list.id, 'Молоко');

    const result = await applyStructuredAction(db, {
      verb: 'Modify',
      targetType: 'listItem',
      targetId: item.id,
      parentListId: list.id,
      content: 'Овсяное молоко',
    });

    expect(result).toEqual({ status: 'applied' });
    const items = await listItemsForList(db, list.id);
    expect(items).toEqual([expect.objectContaining({ id: item.id, text: 'Овсяное молоко' })]);
  });

  it('Complete on a listItem checks it off', async () => {
    const list = await createList(db, 'Покупки');
    const item = await addListItem(db, list.id, 'Молоко');

    const result = await applyStructuredAction(db, {
      verb: 'Complete',
      targetType: 'listItem',
      targetId: item.id,
      parentListId: list.id,
    });

    expect(result).toEqual({ status: 'applied' });
    const items = await listItemsForList(db, list.id);
    expect(items).toEqual([expect.objectContaining({ id: item.id, checked: true })]);
  });

  it('Remove on a listItem deletes it', async () => {
    const list = await createList(db, 'Покупки');
    const item = await addListItem(db, list.id, 'Молоко');

    const result = await applyStructuredAction(db, {
      verb: 'Remove',
      targetType: 'listItem',
      targetId: item.id,
      parentListId: list.id,
    });

    expect(result).toEqual({ status: 'applied' });
    expect(await listItemsForList(db, list.id)).toEqual([]);
  });

  it('Clear on listItems deletes every id in targetIds', async () => {
    const list = await createList(db, 'Покупки');
    const itemA = await addListItem(db, list.id, 'Молоко');
    const itemB = await addListItem(db, list.id, 'Хлеб');

    const result = await applyStructuredAction(db, {
      verb: 'Clear',
      targetType: 'listItem',
      targetId: itemA.id,
      targetIds: [itemA.id, itemB.id],
      parentListId: list.id,
    });

    expect(result).toEqual({ status: 'applied' });
    expect(await listItemsForList(db, list.id)).toEqual([]);
  });

  it('Modify targeting a nonexistent note is reported as failed, not thrown', async () => {
    const result = await applyStructuredAction(db, {
      verb: 'Modify',
      targetType: 'note',
      targetId: 'does-not-exist',
      content: 'irrelevant',
    });

    expect(result).toEqual({ status: 'failed', reason: expect.stringContaining('does-not-exist') });
  });

  it('Remove targeting a nonexistent note is reported as failed, not thrown', async () => {
    const result = await applyStructuredAction(db, {
      verb: 'Remove',
      targetType: 'note',
      targetId: 'does-not-exist',
    });

    expect(result).toEqual({ status: 'failed', reason: expect.stringContaining('does-not-exist') });
  });

  it('Complete targeting a nonexistent listItem is reported as failed, not thrown', async () => {
    const result = await applyStructuredAction(db, {
      verb: 'Complete',
      targetType: 'listItem',
      targetId: 'does-not-exist',
      parentListId: 'some-list-id',
    });

    expect(result).toEqual({ status: 'failed', reason: expect.stringContaining('does-not-exist') });
  });

  it('an unsupported targetType (list) is a no-op, reported as failed, not thrown', async () => {
    const result = await applyStructuredAction(db, {
      verb: 'Capture',
      targetType: 'list',
      targetId: 'yn-server-list-2',
      title: 'Заголовок',
    });

    expect(result.status).toBe('failed');
  });

  it('pulses on a successful note Capture, but not on Modify/Remove/Clear', async () => {
    const haptics = { arrivalPulse: jest.fn() };
    await applyStructuredAction(db, { verb: 'Capture', targetType: 'note', targetId: 'n1', title: 'A', content: 'x' }, undefined, haptics);
    expect(haptics.arrivalPulse).toHaveBeenCalledTimes(1);

    await applyStructuredAction(db, { verb: 'Modify', targetType: 'note', targetId: 'n1', content: 'y' }, undefined, haptics);
    await applyStructuredAction(db, { verb: 'Remove', targetType: 'note', targetId: 'n1' }, undefined, haptics);
    expect(haptics.arrivalPulse).toHaveBeenCalledTimes(1);
  });

  it('pulses on a successful listItem Capture and Complete, but not on Modify/Remove/Clear', async () => {
    const haptics = { arrivalPulse: jest.fn() };
    const list = await createList(db, 'Покупки');
    const item = await addListItem(db, list.id, 'Молоко');

    await applyStructuredAction(db, { verb: 'Capture', targetType: 'listItem', targetId: 'i1', parentListId: list.id, content: 'Хлеб' }, undefined, haptics);
    expect(haptics.arrivalPulse).toHaveBeenCalledTimes(1);

    await applyStructuredAction(db, { verb: 'Complete', targetType: 'listItem', targetId: item.id, parentListId: list.id }, undefined, haptics);
    expect(haptics.arrivalPulse).toHaveBeenCalledTimes(2);

    await applyStructuredAction(db, { verb: 'Modify', targetType: 'listItem', targetId: item.id, parentListId: list.id, content: 'Овсяное молоко' }, undefined, haptics);
    await applyStructuredAction(db, { verb: 'Remove', targetType: 'listItem', targetId: item.id, parentListId: list.id }, undefined, haptics);
    expect(haptics.arrivalPulse).toHaveBeenCalledTimes(2);
  });

  it('does not pulse when a Capture/Complete fails to apply', async () => {
    const haptics = { arrivalPulse: jest.fn() };

    await applyStructuredAction(db, { verb: 'Complete', targetType: 'listItem', targetId: 'does-not-exist', parentListId: 'some-list' }, undefined, haptics);
    await applyStructuredAction(db, { verb: 'Capture', targetType: 'list', targetId: 'yn-x', title: 'Заголовок' }, undefined, haptics);

    expect(haptics.arrivalPulse).not.toHaveBeenCalled();
  });

  it('defaults to the real Android vibration feedback when no haptics dependency is given', async () => {
    // No haptics arg -- exercises the default parameter wiring rather than
    // asserting on the RN Vibration mock itself.
    const result = await applyStructuredAction(db, { verb: 'Capture', targetType: 'note', targetId: 'n-default', title: 'A', content: 'x' });
    expect(result).toEqual({ status: 'applied' });
  });
});

describe('registerActionDispatcher', () => {
  let dir: string;
  let db: OpSqliteDb;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'yunote-dispatcher-register-test-'));
    db = await openMigratedDatabase({ name: 'test.sqlite', location: dir });
  });

  afterEach(() => {
    try {
      db?.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('applies an incoming structured-action message and acknowledges it', async () => {
    const transport = createInMemoryLocalTransport();
    registerActionDispatcher(db, transport);

    await transport.simulateReceive({
      transferId: 'transfer-1',
      kind: 'structured-action',
      small: { verb: 'Capture', targetType: 'note', targetId: 'yn-server-note-3', title: 'Идея', content: 'текст' },
    });

    expect(transport.acknowledgedIds).toEqual(['transfer-1']);
    const notes = await listNotes(db, { sort: 'date-desc' });
    expect(notes).toEqual([expect.objectContaining({ id: 'yn-server-note-3' })]);
  });

  it('ignores a message that is not kind: structured-action', async () => {
    const transport = createInMemoryLocalTransport();
    registerActionDispatcher(db, transport);

    await transport.simulateReceive({ transferId: 'transfer-2', kind: 'linked', small: {} });

    expect(transport.acknowledgedIds).toEqual([]);
  });

  it('still acknowledges a message whose action failed to apply (e.g. targets a missing entity) -- the message was received and handled, even though the action itself reports failure', async () => {
    const transport = createInMemoryLocalTransport();
    registerActionDispatcher(db, transport);

    await transport.simulateReceive({
      transferId: 'transfer-3',
      kind: 'structured-action',
      small: { verb: 'Remove', targetType: 'note', targetId: 'does-not-exist' },
    });

    expect(transport.acknowledgedIds).toEqual(['transfer-3']);
  });

  it('a structured-action message with `small` absent does not throw, acknowledges, and applies nothing', async () => {
    const transport = createInMemoryLocalTransport();
    registerActionDispatcher(db, transport);

    await expect(
      transport.simulateReceive({
        transferId: 'transfer-malformed-1',
        kind: 'structured-action',
        // small omitted entirely
      }),
    ).resolves.toBeUndefined();

    expect(transport.acknowledgedIds).toEqual(['transfer-malformed-1']);
    expect(await listNotes(db, { sort: 'date-desc' })).toEqual([]);
  });

  it('a structured-action message with `small` not an object (a string) does not throw, acknowledges, and applies nothing', async () => {
    const transport = createInMemoryLocalTransport();
    registerActionDispatcher(db, transport);

    await expect(
      transport.simulateReceive({
        transferId: 'transfer-malformed-2',
        kind: 'structured-action',
        small: 'not-an-object' as unknown as Record<string, unknown>,
      }),
    ).resolves.toBeUndefined();

    expect(transport.acknowledgedIds).toEqual(['transfer-malformed-2']);
    expect(await listNotes(db, { sort: 'date-desc' })).toEqual([]);
  });
});
