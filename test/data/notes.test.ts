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
    try {
      db?.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  it('createNote uses a caller-supplied id when given one', async () => {
    const note = await createNote(db, { title: 'Идея', content: 'текст', id: 'explicit-id-1' });
    expect(note.id).toBe('explicit-id-1');

    const all = await listNotes(db, { sort: 'date-desc' });
    expect(all.map((n) => n.id)).toEqual(['explicit-id-1']);
  });

  it('createNote still generates a fresh id when none is given', async () => {
    const note = await createNote(db, { title: 'Идея', content: 'текст' });
    expect(note.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('createNote starts rev at 1', async () => {
    const note = await createNote(db, { title: 'Идея', content: 'текст' });
    expect(note.rev).toBe(1);
  });

  it('updateNote bumps rev by 1 on every call', async () => {
    const note = await createNote(db, { title: 'Идея', content: 'текст' });
    const once = await updateNote(db, note.id, { title: 'Новое' });
    expect(once.rev).toBe(2);
    const twice = await updateNote(db, note.id, { content: 'ещё текст' });
    expect(twice.rev).toBe(3);
  });

  it('createNote marks the new note dirty in sync_outbox', async () => {
    const note = await createNote(db, { title: 'Идея', content: 'текст' });
    const { rows } = await db.execute('SELECT * FROM sync_outbox WHERE entity_id = ?', [note.id]);
    expect(rows).toEqual([
      expect.objectContaining({ entity_type: 'note', entity_id: note.id, deleted: 0, transfer_id: null }),
    ]);
  });

  it('updateNote re-marks the note dirty in sync_outbox (idempotent upsert, not a duplicate row)', async () => {
    const note = await createNote(db, { title: 'Идея', content: 'текст' });
    await updateNote(db, note.id, { title: 'Новое' });
    const { rows } = await db.execute('SELECT * FROM sync_outbox WHERE entity_id = ?', [note.id]);
    expect(rows?.length).toBe(1);
  });

  it('deleteNote marks the note as a deleted tombstone in sync_outbox instead of removing the outbox row', async () => {
    const note = await createNote(db, { title: 'Идея', content: 'текст' });
    await deleteNote(db, note.id);
    const { rows } = await db.execute('SELECT * FROM sync_outbox WHERE entity_id = ?', [note.id]);
    expect(rows).toEqual([
      expect.objectContaining({ entity_type: 'note', entity_id: note.id, deleted: 1 }),
    ]);
  });

  it('deleteNote throws when the note does not exist', async () => {
    await expect(deleteNote(db, 'does-not-exist')).rejects.toThrow('Note not found: does-not-exist');
  });
});
