import { create, type StoreApi, type UseBoundStore } from 'zustand';
import type { OpSqliteDb } from '../db/connection';
import {
  createList as repoCreateList,
  deleteList as repoDeleteList,
  listLists,
  addListItem,
  updateListItem,
  deleteListItem,
  listItemsForList,
  type List,
  type ListItem,
} from '../data/lists';

interface ListsState {
  lists: List[];
  itemsByListId: Record<string, ListItem[]>;
  loadLists(): Promise<void>;
  createList(title: string): Promise<List>;
  deleteList(id: string): Promise<void>;
  loadItems(listId: string): Promise<void>;
  addItem(listId: string, text: string): Promise<ListItem>;
  toggleItem(listId: string, itemId: string): Promise<void>;
  removeItem(listId: string, itemId: string): Promise<void>;
}

export function createListsStore(db: OpSqliteDb,onLocalMutation?:()=>void|Promise<void>): UseBoundStore<StoreApi<ListsState>> {
  const notify=()=>{
    try{void Promise.resolve(onLocalMutation?.()).catch(()=>{});}catch{/* Local persistence already succeeded; a later trigger retries sync. */}
  };
  return create<ListsState>((set, get) => ({
    lists: [],
    itemsByListId: {},
    async loadLists() {
      const lists = await listLists(db);
      set({ lists });
    },
    async createList(title) {
      const list = await repoCreateList(db, title);
      // Reload from the repository rather than prepending locally, so the
      // slice reflects listLists' actual order (updated_at DESC).
      set({ lists: await listLists(db) });
      notify();
      return list;
    },
    async deleteList(id) {
      await repoDeleteList(db, id);
      const { [id]: _removed, ...rest } = get().itemsByListId;
      set({ lists: await listLists(db), itemsByListId: rest });
      notify();
    },
    async loadItems(listId) {
      const items = await listItemsForList(db, listId);
      set({ itemsByListId: { ...get().itemsByListId, [listId]: items } });
    },
    async addItem(listId, text) {
      const item = await addListItem(db, listId, text);
      const items = await listItemsForList(db, listId);
      set({ itemsByListId: { ...get().itemsByListId, [listId]: items } });
      notify();
      return item;
    },
    async toggleItem(listId, itemId) {
      const existing = get().itemsByListId[listId] ?? [];
      const current = existing.find((i) => i.id === itemId);
      await updateListItem(db, itemId, { checked: !current?.checked });
      const items = await listItemsForList(db, listId);
      set({ itemsByListId: { ...get().itemsByListId, [listId]: items } });
      notify();
    },
    async removeItem(listId, itemId) {
      await deleteListItem(db, itemId);
      const items = await listItemsForList(db, listId);
      set({ itemsByListId: { ...get().itemsByListId, [listId]: items } });
      notify();
    },
  }));
}
