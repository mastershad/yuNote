import { openMigratedDatabase, type OpSqliteDb } from '../../src/db/connection';
import { createNotesStore } from '../../src/state/notesStore';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('notes store', () => {
  let dir: string;
  let db: OpSqliteDb;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'yunote-notes-store-test-'));
    db = await openMigratedDatabase({ name: 'test.sqlite', location: dir });
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('loadNotes populates the notes slice from the database', async () => {
    const store = createNotesStore(db);
    await store.getState().createNote({ title: 'Идея', content: 'текст' });

    await store.getState().loadNotes({ sort: 'date-desc' });

    expect(store.getState().notes.map((n) => n.title)).toEqual(['Идея']);
  });

  it('createNote writes to the database and updates the slice without a separate reload', async () => {
    const store = createNotesStore(db);

    await store.getState().createNote({ title: 'Идея', content: 'текст' });

    expect(store.getState().notes.length).toBe(1);
  });

  it('deleteNote removes it from both the database and the slice', async () => {
    const store = createNotesStore(db);
    const note = await store.getState().createNote({ title: 'Идея', content: 'текст' });

    await store.getState().deleteNote(note.id);

    expect(store.getState().notes).toEqual([]);
  });
});
