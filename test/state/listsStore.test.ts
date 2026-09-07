import { openMigratedDatabase, type OpSqliteDb } from '../../src/db/connection';
import { createListsStore } from '../../src/state/listsStore';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('lists store', () => {
  let dir: string;
  let db: OpSqliteDb;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'yunote-lists-store-test-'));
    db = await openMigratedDatabase({ name: 'test.sqlite', location: dir });
  });

  afterEach(() => {
    try {
      db?.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loadLists populates the lists slice', async () => {
    const store = createListsStore(db);
    await store.getState().createList('Покупки');

    await store.getState().loadLists();

    expect(store.getState().lists.map((l) => l.title)).toEqual(['Покупки']);
  });

  it('addItem updates the itemsByListId slice for that list only', async () => {
    const store = createListsStore(db);
    const list = await store.getState().createList('Покупки');

    await store.getState().addItem(list.id, 'Молоко');

    expect(store.getState().itemsByListId[list.id]?.map((i) => i.text)).toEqual(['Молоко']);
  });

  it('toggleItem flips checked in both the database and the slice', async () => {
    const store = createListsStore(db);
    const list = await store.getState().createList('Покупки');
    const item = await store.getState().addItem(list.id, 'Молоко');

    await store.getState().toggleItem(list.id, item.id);

    expect(store.getState().itemsByListId[list.id]?.[0]?.checked).toBe(true);
  });

  it('removeItem removes it from the slice for that list', async () => {
    const store = createListsStore(db);
    const list = await store.getState().createList('Покупки');
    const item = await store.getState().addItem(list.id, 'Молоко');

    await store.getState().removeItem(list.id, item.id);

    expect(store.getState().itemsByListId[list.id]).toEqual([]);
  });

  it('deleteList reloads the lists slice in repository order (updated_at DESC), not local splice/filter order', async () => {
    const store = createListsStore(db);
    const listA = await store.getState().createList('Список A');
    const listB = await store.getState().createList('Список B');
    const trash = await store.getState().createList('Мусор');

    // Directly simulate list A having been touched more recently than B --
    // a naive filter of the pre-mutation local array could never reorder
    // A ahead of B like this; only a real reload from the repository can.
    await db.execute('UPDATE lists SET updated_at = ? WHERE id = ?', ['2099-01-01T00:00:00.000Z', listA.id]);

    await store.getState().deleteList(trash.id);

    expect(store.getState().lists.map((l) => l.id)).toEqual([listA.id, listB.id]);
  });
});
