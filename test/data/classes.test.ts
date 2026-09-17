import { openMigratedDatabase, type OpSqliteDb } from '../../src/db/connection';
import { createClass, deleteClass, renameClass, listClasses } from '../../src/data/classes';
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

  it('deleteClass rejects deleting a class that still has a member note', async () => {
    const cls = await createClass(db, 'Работа');
    await db.execute(
      'INSERT INTO notes (id, title, content, class_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['note-1', 'Идея', 'текст', cls.id, '2026-09-07T00:00:00.000Z', '2026-09-07T00:00:00.000Z'],
    );

    await expect(deleteClass(db, cls.id)).rejects.toThrow(/member notes/);

    expect(await listClasses(db)).toEqual([cls]);
  });

  it('deleteClass rejects deleting a class that still has a member list', async () => {
    const cls = await createClass(db, 'Работа');
    await db.execute(
      'INSERT INTO lists (id, title, class_id, position, purpose, sharing_mode, rev, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, 1, ?, ?)',
      ['list-1', 'Покупки', cls.id, 'generic', 'personal', '2026-09-07T00:00:00.000Z', '2026-09-07T00:00:00.000Z'],
    );

    await expect(deleteClass(db, cls.id)).rejects.toThrow(/member lists/);

    expect(await listClasses(db)).toEqual([cls]);
  });

  it('deleteClass succeeds once the class has no member notes or lists', async () => {
    const cls = await createClass(db, 'Пустой класс');

    await deleteClass(db, cls.id);

    expect(await listClasses(db)).toEqual([]);
  });

  it('createClass, deleteClass, and renameClass never touch dataset_state.revision or mutation_journal', async () => {
    const cls = await createClass(db, 'Работа');
    const renamed = await renameClass(db, cls.id, 'Проекты');
    await deleteClass(db, renamed.id);

    expect((await db.execute('SELECT revision FROM dataset_state')).rows).toEqual([{ revision:0 }]);
    expect((await db.execute('SELECT * FROM mutation_journal')).rows).toEqual([]);
  });

  it('renameClass updates the name and bumps rev', async () => {
    const cls = await createClass(db, 'Работа');

    const renamed = await renameClass(db, cls.id, 'Проекты');

    expect(renamed.name).toBe('Проекты');
    expect(renamed.rev).toBe(cls.rev + 1);
    expect(await listClasses(db)).toEqual([renamed]);
  });
});
