import { create, type StoreApi, type UseBoundStore } from 'zustand';
import type { OpSqliteDb } from '../db/connection';
import { createNote as repoCreateNote, updateNote as repoUpdateNote, deleteNote as repoDeleteNote, listNotes, type Note } from '../data/notes';

interface NotesState {
  notes: Note[];
  loadNotes(options: { classId?: string | null; sort: 'date-desc' | 'date-asc' | 'title-asc' | 'title-desc' }): Promise<void>;
  createNote(input: { title: string; content: string; classId?: string }): Promise<Note>;
  updateNote(id: string, patch: Partial<{ title: string; content: string; classId: string | null }>): Promise<Note>;
  deleteNote(id: string): Promise<void>;
}

export function createNotesStore(db: OpSqliteDb): UseBoundStore<StoreApi<NotesState>> {
  return create<NotesState>((set, get) => ({
    notes: [],
    async loadNotes(options) {
      const notes = await listNotes(db, options);
      set({ notes });
    },
    async createNote(input) {
      const note = await repoCreateNote(db, input);
      set({ notes: [note, ...get().notes] });
      return note;
    },
    async updateNote(id, patch) {
      const updated = await repoUpdateNote(db, id, patch);
      set({ notes: get().notes.map((n) => (n.id === id ? updated : n)) });
      return updated;
    },
    async deleteNote(id) {
      await repoDeleteNote(db, id);
      set({ notes: get().notes.filter((n) => n.id !== id) });
    },
  }));
}
