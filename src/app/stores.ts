import { openMigratedDatabase } from '../db/connection';
import { createNotesStore } from '../state/notesStore';
import { createListsStore } from '../state/listsStore';

export interface AppStores {
  notes: ReturnType<typeof createNotesStore>;
  lists: ReturnType<typeof createListsStore>;
  close(): void;
}

export async function createAppStores(): Promise<AppStores> {
  const db = await openMigratedDatabase({
    name: 'yunote.sqlite',
    location: 'default',
  });
  const notes = createNotesStore(db);
  const lists = createListsStore(db);

  try {
    await Promise.all([
      notes.getState().loadNotes({ sort: 'date-desc' }),
      lists.getState().loadLists(),
    ]);
  } catch (error) {
    db.close();
    throw error;
  }

  return {
    notes,
    lists,
    close: () => db.close(),
  };
}

