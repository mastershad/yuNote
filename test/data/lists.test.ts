import { openMigratedDatabase, type OpSqliteDb } from '../../src/db/connection';
import {
  createList,
  deleteList,
  listLists,
  addListItem,
  updateListItem,
  deleteListItem,
  listItemsForList,
} from '../../src/data/lists';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('lists repository', () => {
  let dir: string;
  let db: OpSqliteDb;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'yunote-lists-test-'));
    db = await openMigratedDatabase({ name: 'test.sqlite', location: dir });
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates and lists a list', async () => {
    const list = await createList(db, 'Покупки');
    expect(await listLists(db)).toEqual([list]);
  });

  it('adds items to a list, unchecked by default', async () => {
    const list = await createList(db, 'Покупки');
    const item = await addListItem(db, list.id, 'Молоко');

    expect(item.text).toBe('Молоко');
    expect(item.checked).toBe(false);
    expect(item.listId).toBe(list.id);
  });

  it('updateListItem can toggle checked and edit text independently', async () => {
    const list = await createList(db, 'Покупки');
    const item = await addListItem(db, list.id, 'Молоко');

    const checked = await updateListItem(db, item.id, { checked: true });
    expect(checked.checked).toBe(true);
    expect(checked.text).toBe('Молоко');

    const renamed = await updateListItem(db, item.id, { text: 'Овсяное молоко' });
    expect(renamed.text).toBe('Овсяное молоко');
    expect(renamed.checked).toBe(true);
  });

  it('deleteListItem removes only that item', async () => {
    const list = await createList(db, 'Покупки');
    const keep = await addListItem(db, list.id, 'Молоко');
    const remove = await addListItem(db, list.id, 'Хлеб');

    await deleteListItem(db, remove.id);

    const remaining = await listItemsForList(db, list.id);
    expect(remaining.map((i) => i.id)).toEqual([keep.id]);
  });

  it('deleteList cascades to its items', async () => {
    const list = await createList(db, 'Покупки');
    await addListItem(db, list.id, 'Молоко');

    await deleteList(db, list.id);

    expect(await listLists(db)).toEqual([]);
    expect(await listItemsForList(db, list.id)).toEqual([]);
  });

  it('listItemsForList only returns items for that list', async () => {
    const listA = await createList(db, 'Покупки');
    const listB = await createList(db, 'Дела');
    await addListItem(db, listA.id, 'Молоко');
    await addListItem(db, listB.id, 'Позвонить маме');

    const itemsA = await listItemsForList(db, listA.id);
    expect(itemsA.map((i) => i.text)).toEqual(['Молоко']);
  });
});
