import { openMigratedDatabase, type OpSqliteDb } from '../../src/db/connection';
import { createClass, deleteClass, listClasses } from '../../src/data/classes';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('classes repository', () => {
  let dir: string;
  let db: OpSqliteDb;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'yunote-classes-test-'));
    db = await openMigratedDatabase({ name: 'test.sqlite', location: dir });
  });

  afterEach(() => {
    try {
      db?.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates a class and lists it back', async () => {
    const created = await createClass(db, 'Работа');

    expect(created.name).toBe('Работа');
    expect(typeof created.id).toBe('string');

    const all = await listClasses(db);
    expect(all).toEqual([created]);
  });

  it('can exist with zero notes referencing it', async () => {
    await createClass(db, 'Пустой класс');

    const all = await listClasses(db);
    expect(all.length).toBe(1);
  });

  it('deleteClass removes the class but does not delete its notes -- their class_id becomes NULL', async () => {
    const cls = await createClass(db, 'Работа');
    await db.execute(
      'INSERT INTO notes (id, title, content, class_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['note-1', 'Идея', 'текст', cls.id, '2026-09-07T00:00:00.000Z', '2026-09-07T00:00:00.000Z'],
    );

    await deleteClass(db, cls.id);

    const remainingClasses = await listClasses(db);
    expect(remainingClasses).toEqual([]);

    const { rows } = await db.execute('SELECT * FROM notes WHERE id = ?', ['note-1']);
    expect(rows?.length).toBe(1);
    expect(rows?.[0]?.class_id).toBeNull();
  });
});
