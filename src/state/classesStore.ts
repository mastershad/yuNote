import { create, type StoreApi, type UseBoundStore } from 'zustand';
import type { OpSqliteDb } from '../db/connection';
import { createClass as repoCreateClass, deleteClass as repoDeleteClass, listClasses, type Class } from '../data/classes';

interface ClassesState {
  classes: Class[];
  loadClasses(): Promise<void>;
  createClass(name: string): Promise<Class>;
  deleteClass(id: string): Promise<void>;
}

export function createClassesStore(db: OpSqliteDb): UseBoundStore<StoreApi<ClassesState>> {
  return create<ClassesState>((set, get) => ({
    classes: [],
    async loadClasses() {
      const classes = await listClasses(db);
      set({ classes });
    },
    async createClass(name) {
      const cls = await repoCreateClass(db, name);
      set({ classes: [...get().classes, cls] });
      return cls;
    },
    async deleteClass(id) {
      await repoDeleteClass(db, id);
      set({ classes: get().classes.filter((c) => c.id !== id) });
    },
  }));
}
