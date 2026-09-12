import { create, type StoreApi, type UseBoundStore } from 'zustand';
import type { OpSqliteDb } from '../db/connection';
import { createNote as repoCreateNote, updateNote as repoUpdateNote, deleteNote as repoDeleteNote, listNotes, type Note } from '../data/notes';

type LoadNotesOptions = { classId?: string | null; sort: 'date-desc' | 'date-asc' | 'title-asc' | 'title-desc' };

interface NotesState {
  notes: Note[];
  // undefined until loadNotes is first called -- tracks the filter/sort the
  // `notes` slice was most recently loaded with, so mutations can reload
  // against the same options instead of hand-splicing (and silently
  // ignoring an active filter/sort). Left undefined preserves the original
  // local-splice behavior for callers that mutate without ever loading.
  lastLoadOptions?: LoadNotesOptions;
  loadNotes(options: LoadNotesOptions): Promise<void>;
  createNote(input: { title: string; content: string; classId?: string }): Promise<Note>;
  updateNote(id: string, patch: Partial<{ title: string; content: string; classId: string | null }>): Promise<Note>;
  deleteNote(id: string): Promise<void>;
}

export function createNotesStore(db: OpSqliteDb,onLocalMutation?:()=>void|Promise<void>): UseBoundStore<StoreApi<NotesState>> {
  const notify=()=>{
    try{void Promise.resolve(onLocalMutation?.()).catch(()=>{});}catch{/* Local persistence already succeeded; a later trigger retries sync. */}
  };
  return create<NotesState>((set, get) => ({
    notes: [],
    lastLoadOptions: undefined,
    async loadNotes(options) {
      const notes = await listNotes(db, options);
      set({ notes, lastLoadOptions: options });
    },
    async createNote(input) {
      const note = await repoCreateNote(db, input);
      const { lastLoadOptions } = get();
      if (lastLoadOptions) {
        set({ notes: await listNotes(db, lastLoadOptions) });
      } else {
        set({ notes: [note, ...get().notes] });
      }
      notify();
      return note;
    },
    async updateNote(id, patch) {
      const updated = await repoUpdateNote(db, id, patch);
      const { lastLoadOptions } = get();
      if (lastLoadOptions) {
        set({ notes: await listNotes(db, lastLoadOptions) });
      } else {
        set({ notes: get().notes.map((n) => (n.id === id ? updated : n)) });
      }
      notify();
      return updated;
    },
    async deleteNote(id) {
      await repoDeleteNote(db, id);
      const { lastLoadOptions } = get();
      if (lastLoadOptions) {
        set({ notes: await listNotes(db, lastLoadOptions) });
      } else {
        set({ notes: get().notes.filter((n) => n.id !== id) });
      }
      notify();
    },
  }));
}
