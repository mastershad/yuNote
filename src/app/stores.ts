import { openMigratedDatabase } from '../db/connection';
import { createNotesStore } from '../state/notesStore';
import { createListsStore } from '../state/listsStore';
import { createClassesStore } from '../state/classesStore';
import {createInstallationSync,type InstallationSync} from '../sync/installationSync';

export interface AppStores {
  notes: ReturnType<typeof createNotesStore>;
  lists: ReturnType<typeof createListsStore>;
  classes: ReturnType<typeof createClassesStore>;
  requestSync():void;
  close(): void;
}

export async function createAppStores(options:{installationSyncFactory?:(db:Awaited<ReturnType<typeof openMigratedDatabase>>)=>InstallationSync}={}): Promise<AppStores> {
  const db = await openMigratedDatabase({
    name: 'yunote.sqlite',
    location: 'default',
  });
  const installationSync=(options.installationSyncFactory??createInstallationSync)(db);
  const requestSync=()=>{void installationSync.flushIfEnrolled().catch(()=>{/* Offline journal remains queued for the next trigger. */});};
  const notes = createNotesStore(db,requestSync);
  const lists = createListsStore(db,requestSync);
  const classes = createClassesStore(db);

  try {
    await Promise.all([
      notes.getState().loadNotes({ classId: null, sort: 'date-desc' }),
      lists.getState().loadLists(),
      classes.getState().loadClasses(),
    ]);
  } catch (error) {
    db.close();
    throw error;
  }

  return {
    notes,
    lists,
    classes,
    requestSync,
    close: () => db.close(),
  };
}
