import { create, type StoreApi, type UseBoundStore } from 'zustand';
import type { OpSqliteDb } from '../db/connection';
import {
  createClass as repoCreateClass,
  deleteClass as repoDeleteClass,
  renameClass as repoRenameClass,
  listClasses,
  listClassNoteCounts,
  type Class,
} from '../data/classes';

interface ClassesState {
  classes: Class[];
  noteCounts: Record<string, number>;
  loadClasses(): Promise<void>;
  createClass(name: string): Promise<Class>;
  deleteClass(id: string): Promise<void>;
  renameClass(id: string, name: string): Promise<Class>;
}

async function loadClassesAndCounts(db: OpSqliteDb): Promise<{ classes: Class[]; noteCounts: Record<string, number> }> {
  const [classes, noteCounts] = await Promise.all([listClasses(db), listClassNoteCounts(db)]);
  return { classes, noteCounts };
}

export function createClassesStore(db: OpSqliteDb): UseBoundStore<StoreApi<ClassesState>> {
  return create<ClassesState>((set) => ({
    classes: [],
    noteCounts: {},
    async loadClasses() {
      set(await loadClassesAndCounts(db));
    },
    async createClass(name) {
      const cls = await repoCreateClass(db, name);
      set(await loadClassesAndCounts(db));
      return cls;
    },
    async deleteClass(id) {
      await repoDeleteClass(db, id);
      set(await loadClassesAndCounts(db));
    },
    async renameClass(id, name) {
      const cls = await repoRenameClass(db, id, name);
      set(await loadClassesAndCounts(db));
      return cls;
    },
  }));
}
