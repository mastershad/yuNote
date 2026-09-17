import { openMigratedDatabase, type OpSqliteDb } from '../../src/db/connection';
import { createNotesStore } from '../../src/state/notesStore';
import { createClassesStore } from '../../src/state/classesStore';
import { createNote } from '../../src/data/notes';
import { createClassFromNotes } from '../../src/data/classes';
import {
  createClassFromNotesAndReload,
  addNoteToClassAndReload,
  removeNoteFromClassAndReload,
} from '../../src/state/classInteractions';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('classInteractions', () => {
  let dir: string;
  let db: OpSqliteDb;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'yunote-class-interactions-'));
    db = await openMigratedDatabase({ name: 'test.sqlite', location: dir });
  });

  afterEach(() => {
    try { db?.close(); } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('createClassFromNotesAndReload reloads both stores, removing the two notes from the root feed', async () => {
    const notesStore = createNotesStore(db);
    const classesStore = createClassesStore(db);
    const noteA = await createNote(db, { title: 'A', content: '' });
    const noteB = await createNote(db, { title: 'B', content: '' });
    await notesStore.getState().loadNotes({ classId: null, sort: 'date-desc' });
    await classesStore.getState().loadClasses();
    expect(notesStore.getState().notes).toHaveLength(2);

    const klass = await createClassFromNotesAndReload(db, notesStore, classesStore, { noteAId: noteA.id, noteBId: noteB.id });

    expect(notesStore.getState().notes).toHaveLength(0); // both notes are now classified, out of the root feed
    expect(classesStore.getState().classes.map((c) => c.id)).toEqual([klass.id]);
    expect(classesStore.getState().noteCounts[klass.id]).toBe(2);
  });

  it('addNoteToClassAndReload reloads both stores', async () => {
    const notesStore = createNotesStore(db);
    const classesStore = createClassesStore(db);
    const noteA = await createNote(db, { title: 'A', content: '' });
    const noteB = await createNote(db, { title: 'B', content: '' });
    const klass = await createClassFromNotes(db, { noteAId: noteA.id, noteBId: noteB.id });
    const noteC = await createNote(db, { title: 'C', content: '' });
    await notesStore.getState().loadNotes({ classId: null, sort: 'date-desc' });
    await classesStore.getState().loadClasses();

    await addNoteToClassAndReload(db, notesStore, classesStore, { noteId: noteC.id, classId: klass.id });

    expect(notesStore.getState().notes).toHaveLength(0);
    expect(classesStore.getState().noteCounts[klass.id]).toBe(3);
  });

  it('removeNoteFromClassAndReload reloads both stores and reflects auto-dissolve when it happens', async () => {
    const notesStore = createNotesStore(db);
    const classesStore = createClassesStore(db);
    const noteA = await createNote(db, { title: 'A', content: '' });
    const noteB = await createNote(db, { title: 'B', content: '' });
    await createClassFromNotes(db, { noteAId: noteA.id, noteBId: noteB.id });
    await notesStore.getState().loadNotes({ classId: null, sort: 'date-desc' });
    await classesStore.getState().loadClasses();

    await removeNoteFromClassAndReload(db, notesStore, classesStore, noteA.id);

    expect(classesStore.getState().classes).toEqual([]); // dissolved -- only 1 member would have remained
    expect(notesStore.getState().notes.map((n) => n.id).sort()).toEqual([noteA.id, noteB.id].sort());
  });
});
