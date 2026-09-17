import { openMigratedDatabase, type OpSqliteDb } from '../../src/db/connection';
import { createClassesStore } from '../../src/state/classesStore';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('classes store', () => {
  let dir: string;
  let db: OpSqliteDb;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'yunote-classes-store-test-'));
    db = await openMigratedDatabase({ name: 'test.sqlite', location: dir });
  });

  afterEach(() => {
    try {
      db?.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('createClass updates the slice without a separate reload', async () => {
    const store = createClassesStore(db);

    await store.getState().createClass('Работа');

    expect(store.getState().classes.map((c) => c.name)).toEqual(['Работа']);
  });

  it('deleteClass removes it from the slice', async () => {
    const store = createClassesStore(db);
    const cls = await store.getState().createClass('Работа');

    await store.getState().deleteClass(cls.id);

    expect(store.getState().classes).toEqual([]);
  });

  it('createClass reloads from the repository, so the slice reflects name-sorted order rather than insertion/append order', async () => {
    const store = createClassesStore(db);
    await store.getState().createClass('Работа');

    // "Быт" sorts before "Работа" -- an append would put it last.
    await store.getState().createClass('Быт');

    expect(store.getState().classes.map((c) => c.name)).toEqual(['Быт', 'Работа']);
  });

  it('renameClass updates the slice in place', async () => {
    const store = createClassesStore(db);
    const cls = await store.getState().createClass('Работа');

    const renamed = await store.getState().renameClass(cls.id, 'Проекты');

    expect(renamed.name).toBe('Проекты');
    expect(store.getState().classes.map((c) => c.name)).toEqual(['Проекты']);
  });

  it('loadClasses also loads noteCounts', async () => {
    const store = createClassesStore(db);
    const cls = await store.getState().createClass('Работа');

    await store.getState().loadClasses();

    expect(store.getState().noteCounts).toEqual({});
    // 0 members isn't in the map at all (matches listClassNoteCounts, which
    // only returns classes with at least one member) -- not the same as {[cls.id]: 0}.
    expect(store.getState().noteCounts[cls.id]).toBeUndefined();
  });
});
