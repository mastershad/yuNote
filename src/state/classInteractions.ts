import type { OpSqliteDb } from '../db/connection';
import type { Note } from '../data/notes';
import type { Class } from '../data/classes';
import { createClassFromNotes, addNoteToClass, removeNoteFromClass } from '../data/classes';
import type { createNotesStore } from './notesStore';
import type { createClassesStore } from './classesStore';

type NotesStore = ReturnType<typeof createNotesStore>;
type ClassesStore = ReturnType<typeof createClassesStore>;

async function reloadBoth(db: OpSqliteDb, notesStore: NotesStore, classesStore: ClassesStore): Promise<void> {
  const noteOptions = notesStore.getState().lastLoadOptions ?? { classId: null as string | null, sort: 'date-desc' as const };
  await Promise.all([
    notesStore.getState().loadNotes(noteOptions),
    classesStore.getState().loadClasses(),
  ]);
}

export async function createClassFromNotesAndReload(
  db: OpSqliteDb, notesStore: NotesStore, classesStore: ClassesStore,
  input: { noteAId: string; noteBId: string },
): Promise<Class> {
  const klass = await createClassFromNotes(db, input);
  await reloadBoth(db, notesStore, classesStore);
  return klass;
}

export async function addNoteToClassAndReload(
  db: OpSqliteDb, notesStore: NotesStore, classesStore: ClassesStore,
  input: { noteId: string; classId: string },
): Promise<Note> {
  const note = await addNoteToClass(db, input);
  await reloadBoth(db, notesStore, classesStore);
  return note;
}

export async function removeNoteFromClassAndReload(
  db: OpSqliteDb, notesStore: NotesStore, classesStore: ClassesStore, noteId: string,
): Promise<Note> {
  const note = await removeNoteFromClass(db, noteId);
  await reloadBoth(db, notesStore, classesStore);
  return note;
}
