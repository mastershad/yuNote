import { openMigratedDatabase, type OpSqliteDb } from '../../src/db/connection';
import { createNote, updateNote, deleteNote, listNotes } from '../../src/data/notes';
import { createClass } from '../../src/data/classes';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('notes repository', () => {
  let dir: string;
  let db: OpSqliteDb;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'yunote-notes-test-'));
    db = await openMigratedDatabase({ name: 'test.sqlite', location: dir });
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates a note with no class by default', async () => {
    const note = await createNote(db, { title: 'Идея', content: 'текст' });

    expect(note.title).toBe('Идея');
    expect(note.classId).toBeNull();
    expect(note.createdAt).toBe(note.updatedAt);
  });

  it('creates a note with an explicit classId', async () => {
    const cls = await createClass(db, 'Test Class');
    const note = await createNote(db, { title: 'Идея', content: 'текст', classId: cls.id });
    expect(note.classId).toBe(cls.id);
  });

  it('updateNote patches only the given fields, leaving the rest unchanged', async () => {
    const note = await createNote(db, { title: 'Старое', content: 'старый текст' });

    const updated = await updateNote(db, note.id, { title: 'Новое' });

    expect(updated.title).toBe('Новое');
    expect(updated.content).toBe('старый текст');
    expect(updated.id).toBe(note.id);
    expect(updated.createdAt).toBe(note.createdAt);
  });

  it('updateNote can set classId back to null (unclassify)', async () => {
    const cls = await createClass(db, 'Test Class');
    const note = await createNote(db, { title: 'Идея', content: 'текст', classId: cls.id });

    const updated = await updateNote(db, note.id, { classId: null });

    expect(updated.classId).toBeNull();
  });

  it('deleteNote removes the row', async () => {
    const note = await createNote(db, { title: 'Идея', content: 'текст' });

    await deleteNote(db, note.id);

    const all = await listNotes(db, { sort: 'date-desc' });
    expect(all).toEqual([]);
  });

  it('listNotes filters by classId', async () => {
    const cls = await createClass(db, 'Test Class');
    await createNote(db, { title: 'A', content: '', classId: cls.id });
    await createNote(db, { title: 'B', content: '' });

    const classified = await listNotes(db, { classId: cls.id, sort: 'date-desc' });
    expect(classified.map((n) => n.title)).toEqual(['A']);

    const unclassified = await listNotes(db, { classId: null, sort: 'date-desc' });
    expect(unclassified.map((n) => n.title)).toEqual(['B']);
  });

  it('listNotes sorts by title ascending and descending', async () => {
    await createNote(db, { title: 'Банан', content: '' });
    await createNote(db, { title: 'Апельсин', content: '' });

    const asc = await listNotes(db, { sort: 'title-asc' });
    expect(asc.map((n) => n.title)).toEqual(['Апельсин', 'Банан']);

    const desc = await listNotes(db, { sort: 'title-desc' });
    expect(desc.map((n) => n.title)).toEqual(['Банан', 'Апельсин']);
  });
});
