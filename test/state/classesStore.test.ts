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
    db.close();
    rmSync(dir, { recursive: true, force: true });
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
});
