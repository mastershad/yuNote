import { openMigratedDatabase, type OpSqliteDb } from '../../src/db/connection';
import { createNotesStore } from '../../src/state/notesStore';
import { createClass } from '../../src/data/classes';
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
    try {
      db?.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  it('createNote after a class-filtered loadNotes does not surface a note outside that filter', async () => {
    const store = createNotesStore(db);
    const cls = await createClass(db, 'Работа');
    await store.getState().createNote({ title: 'В классе', content: '', classId: cls.id });

    await store.getState().loadNotes({ classId: cls.id, sort: 'date-desc' });
    expect(store.getState().notes.map((n) => n.title)).toEqual(['В классе']);

    // Created without the active filter's classId -- should not appear in
    // the still-filtered slice.
    await store.getState().createNote({ title: 'Без класса', content: '' });

    expect(store.getState().notes.map((n) => n.title)).toEqual(['В классе']);
  });

  it('createNote after a title-asc loadNotes inserts the new note in sorted position, not prepended', async () => {
    const store = createNotesStore(db);
    await store.getState().createNote({ title: 'Банан', content: '' });

    await store.getState().loadNotes({ sort: 'title-asc' });
    expect(store.getState().notes.map((n) => n.title)).toEqual(['Банан']);

    await store.getState().createNote({ title: 'Апельсин', content: '' });

    expect(store.getState().notes.map((n) => n.title)).toEqual(['Апельсин', 'Банан']);
  });

  it('updateNote unclassifying a note removes it from the class-filtered slice it was loaded into', async () => {
    const store = createNotesStore(db);
    const cls = await createClass(db, 'Работа');
    const note = await store.getState().createNote({ title: 'Идея', content: '', classId: cls.id });

    await store.getState().loadNotes({ classId: cls.id, sort: 'date-desc' });
    expect(store.getState().notes.map((n) => n.title)).toEqual(['Идея']);

    await store.getState().updateNote(note.id, { classId: null });

    expect(store.getState().notes).toEqual([]);
  });

  it('requests sync after the local UI update without waiting for the network',async()=>{
    let finishSync!:()=>void;
    const pending=new Promise<void>(resolve=>{finishSync=resolve;});
    const requestSync=jest.fn(()=>pending);
    const store=createNotesStore(db,requestSync);
    const created=await store.getState().createNote({title:'Сразу локально',content:'Офлайн'});
    expect(created.title).toBe('Сразу локально');
    expect(store.getState().notes.map(note=>note.title)).toEqual(['Сразу локально']);
    expect(requestSync).toHaveBeenCalledTimes(1);
    finishSync();
  });
});
