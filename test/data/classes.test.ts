import { openMigratedDatabase, type OpSqliteDb } from '../../src/db/connection';
import { createClass, deleteClass, renameClass, createClassFromNotes, addNoteToClass, removeNoteFromClass, listClassNoteCounts, listClasses } from '../../src/data/classes';
import { createNote, deleteNote } from '../../src/data/notes';
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

  it('createClassFromNotes groups two unclassified notes into a new class named "Новый класс"', async () => {
    const noteA = await createNote(db, { title: 'Идея', content: 'A' });
    const noteB = await createNote(db, { title: 'Другая идея', content: 'B' });

    const klass = await createClassFromNotes(db, { noteAId: noteA.id, noteBId: noteB.id });

    expect(klass.name).toBe('Новый класс');
    const { rows } = await db.execute('SELECT id,class_id FROM notes ORDER BY id');
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: noteA.id, class_id: klass.id }),
        expect.objectContaining({ id: noteB.id, class_id: klass.id }),
      ]),
    );
  });

  it('createClassFromNotes journals both note upserts (mixed operation, no class event journaled)', async () => {
    const noteA = await createNote(db, { title: 'A', content: '' });
    const noteB = await createNote(db, { title: 'B', content: '' });

    await createClassFromNotes(db, { noteAId: noteA.id, noteBId: noteB.id });

    const events = (await db.execute('SELECT entity_type,entity_id,mutation FROM mutation_journal ORDER BY dataset_revision,sequence')).rows ?? [];
    expect(events.every((e) => e.entity_type !== 'class')).toBe(true);
    // 4 total note-upsert events in this test: one per createNote call (2),
    // plus one per note reassigned to the new class inside createClassFromNotes (2).
    expect(events.filter((e) => e.entity_type === 'note' && e.mutation === 'upsert')).toHaveLength(4);
  });

  it('createClassFromNotes rejects if either note already belongs to a class (stale assumption)', async () => {
    const existing = await createClass(db, 'Существующий');
    const noteA = await createNote(db, { title: 'A', content: '', classId: existing.id });
    const noteB = await createNote(db, { title: 'B', content: '' });

    await expect(createClassFromNotes(db, { noteAId: noteA.id, noteBId: noteB.id })).rejects.toThrow(/already belongs/);

    expect((await listClasses(db)).length).toBe(1); // no orphaned second class created
  });

  it('createClassFromNotes rejects if either note no longer exists', async () => {
    const noteA = await createNote(db, { title: 'A', content: '' });

    await expect(createClassFromNotes(db, { noteAId: noteA.id, noteBId: 'missing' })).rejects.toThrow(/no longer exist/);
  });

  it('createClassFromNotes rejects a note dropped onto itself (same id twice), rather than creating a 1-member class', async () => {
    const noteA = await createNote(db, { title: 'A', content: '' });

    await expect(createClassFromNotes(db, { noteAId: noteA.id, noteBId: noteA.id })).rejects.toThrow(/itself/);

    expect(await listClasses(db)).toEqual([]); // no invariant-violating class left behind
  });

  it('addNoteToClass adds an unclassified note to an existing class and touches the class', async () => {
    const klass = await createClass(db, 'Работа');
    const note = await createNote(db, { title: 'Идея', content: '' });
    const before = klass.updatedAt;

    const updated = await addNoteToClass(db, { noteId: note.id, classId: klass.id });

    expect(updated.classId).toBe(klass.id);
    const reloaded = (await listClasses(db))[0];
    expect(reloaded.rev).toBe(klass.rev + 1);
    expect(reloaded.updatedAt >= before).toBe(true);
  });

  it('addNoteToClass rejects a note that already has a class', async () => {
    const klassA = await createClass(db, 'A');
    const klassB = await createClass(db, 'B');
    const note = await createNote(db, { title: 'Идея', content: '', classId: klassA.id });

    await expect(addNoteToClass(db, { noteId: note.id, classId: klassB.id })).rejects.toThrow(/already belongs/);
  });

  it('the ≥2-member invariant holds via removeNoteFromClass: removing the second-to-last note dissolves the class', async () => {
    const noteA = await createNote(db, { title: 'A', content: '' });
    const noteB = await createNote(db, { title: 'B', content: '' });
    const klass = await createClassFromNotes(db, { noteAId: noteA.id, noteBId: noteB.id });

    const removed = await removeNoteFromClass(db, noteA.id);

    expect(removed.classId).toBeNull();
    const { rows } = await db.execute('SELECT class_id FROM notes WHERE id=?', [noteB.id]);
    expect((rows?.[0] as { class_id: string | null }).class_id).toBeNull(); // auto-dissolved
    expect(await listClasses(db)).toEqual([]);
  });

  it('the ≥2-member invariant holds via deleteNote: deleting the second-to-last note dissolves the class', async () => {
    const noteA = await createNote(db, { title: 'A', content: '' });
    const noteB = await createNote(db, { title: 'B', content: '' });
    await createClassFromNotes(db, { noteAId: noteA.id, noteBId: noteB.id });

    await deleteNote(db, noteA.id);

    const { rows } = await db.execute('SELECT class_id FROM notes WHERE id=?', [noteB.id]);
    expect((rows?.[0] as { class_id: string | null }).class_id).toBeNull();
    expect(await listClasses(db)).toEqual([]);
  });

  it('a class with 3+ members just gets touched (rev bump) when one note is removed, not dissolved', async () => {
    const noteA = await createNote(db, { title: 'A', content: '' });
    const noteB = await createNote(db, { title: 'B', content: '' });
    const klass = await createClassFromNotes(db, { noteAId: noteA.id, noteBId: noteB.id });
    const noteC = await createNote(db, { title: 'C', content: '' });
    await addNoteToClass(db, { noteId: noteC.id, classId: klass.id });

    await removeNoteFromClass(db, noteA.id);

    const remaining = await listClasses(db);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].rev).toBeGreaterThan(klass.rev);
  });

  it('removeNoteFromClass rejects a note that has no class', async () => {
    const note = await createNote(db, { title: 'A', content: '' });

    await expect(removeNoteFromClass(db, note.id)).rejects.toThrow(/not in a class/);
  });

  it('listClassNoteCounts returns member counts keyed by class id', async () => {
    const noteA = await createNote(db, { title: 'A', content: '' });
    const noteB = await createNote(db, { title: 'B', content: '' });
    const klass = await createClassFromNotes(db, { noteAId: noteA.id, noteBId: noteB.id });
    const emptyish = await createClass(db, 'Только что созданный'); // 0 members, valid pre-dissolve-check state

    const counts = await listClassNoteCounts(db);

    expect(counts[klass.id]).toBe(2);
    expect(counts[emptyish.id]).toBeUndefined();
  });
});
