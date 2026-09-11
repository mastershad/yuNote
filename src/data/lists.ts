import type { OpSqliteDb, OpSqliteExecutor } from '../db/connection';
import { generateId, nowIso } from './id';
import { markDirty } from './syncOutbox';
import { runLocalOperation, type JournalEvent } from './localOperation';

export interface List {
  id: string;
  title: string;
  classId:string|null;
  position:number;
  rev: number;
  createdAt: string;
  updatedAt: string;
}

export interface ListItem {
  id: string;
  listId: string;
  text: string;
  checked: boolean;
  rev: number;
  createdAt: string;
  updatedAt: string;
  position:number;
}

interface ListRow {
  id: string;
  title: string;
  class_id:string|null;
  position:number;
  rev: number;
  created_at: string;
  updated_at: string;
}

interface ListItemRow {
  id: string;
  list_id: string;
  text: string;
  checked: number;
  rev: number;
  created_at: string;
  updated_at: string;
  position:number;
}

function toList(row: ListRow): List {
  return { id:row.id,title:row.title,classId:row.class_id,position:row.position,rev:row.rev,createdAt:row.created_at,updatedAt:row.updated_at };
}

function toListItem(row: ListItemRow): ListItem {
  return {
    id: row.id,
    listId: row.list_id,
    text: row.text,
    checked: row.checked === 1,
    rev: row.rev,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    position:row.position,
  };
}

export async function createListInTransaction(tx:OpSqliteExecutor,input:{ id:string;title:string;classId:string|null;position?:number }):Promise<{ list:List;events:JournalEvent[] }> {
  const timestamp=nowIso();
  const list:List={ id:input.id,title:input.title,classId:input.classId,position:input.position ?? 0,rev:1,createdAt:timestamp,updatedAt:timestamp };
  await tx.execute('INSERT INTO lists (id,title,class_id,position,rev,created_at,updated_at) VALUES (?,?,?,?,1,?,?)',
    [list.id,list.title,list.classId,list.position,timestamp,timestamp]);
  await markDirty(tx,'list',list.id,false);
  return { list,events:[{ entityType:'list',entityId:list.id,mutation:'upsert',payload:list }] };
}

export async function updateListInTransaction(
  tx:OpSqliteExecutor,id:string,patch:Partial<{ title:string;classId:string|null;position:number }>,
):Promise<{ list:List;events:JournalEvent[] }> {
  const { rows }=await tx.execute('SELECT * FROM lists WHERE id=?',[id]);
  if (!rows?.[0]) throw new Error(`List not found: ${id}`);
  const existing=toList(rows[0] as unknown as ListRow);
  const list:List={ ...existing,...(patch.title!==undefined?{title:patch.title}:{}),...(patch.classId!==undefined?{classId:patch.classId}:{}),
    ...(patch.position!==undefined?{position:patch.position}:{}),rev:existing.rev+1,updatedAt:nowIso() };
  await tx.execute('UPDATE lists SET title=?,class_id=?,position=?,rev=?,updated_at=? WHERE id=?',
    [list.title,list.classId,list.position,list.rev,list.updatedAt,id]);
  await markDirty(tx,'list',id,false);
  return { list,events:[{ entityType:'list',entityId:id,mutation:'upsert',payload:list }] };
}

export async function createList(db: OpSqliteDb, title: string, options?: { id?: string;classId?:string|null }): Promise<List> {
  const id = options?.id ?? generateId();
  const classId=options?.classId ?? null;
  const outcome=await runLocalOperation(db,{ operationId:generateId(),request:{ action:'createList',id,title,classId },execute:async(tx)=>{
    const created=await createListInTransaction(tx,{ id,title,classId });
    return { result:created.list,events:created.events };
  }});
  return outcome.result;
}

export async function deleteListInTransaction(tx:OpSqliteExecutor,id:string):Promise<JournalEvent[]> {
  const { rows:listRows }=await tx.execute('SELECT id FROM lists WHERE id=?',[id]);
  if (!listRows?.length) throw new Error(`List not found: ${id}`);
  const { rows }=await tx.execute('SELECT id FROM list_items WHERE list_id=?',[id]);
  await tx.execute('DELETE FROM list_items WHERE list_id=?',[id]);
  await tx.execute('DELETE FROM lists WHERE id=?',[id]);
  await markDirty(tx,'list',id,true);
  for (const row of (rows ?? []) as { id:string }[]) await tx.execute('DELETE FROM sync_outbox WHERE entity_type=? AND entity_id=?',['listItem',row.id]);
  return [{ entityType:'list',entityId:id,mutation:'delete' }];
}

export async function deleteList(db: OpSqliteDb, id: string): Promise<void> {
  // Cascades to items, deliberately unlike deleteClass -- a list's items
  // aren't meaningful without the list, whereas a class is just a label.
  // Each item's own tombstone (from a prior deleteListItem call, or one
  // this function would need to write per item) is deliberately NOT
  // written here for items that were never individually deleted --
  // Key Fob/cloud-platform's own DELETE /yunote/sync/lists/:id already
  // cascades the same way server-side (yunoteSyncStore.deleteList), so
  // one tombstone for the list is sufficient; the items simply vanish
  // from both sides without needing their own delete messages.
  await runLocalOperation(db,{ operationId:generateId(),request:{ action:'deleteList',id },execute:async(tx)=>({
    result:{ status:'deleted' },events:await deleteListInTransaction(tx,id),
  })});
}

export async function listLists(db: OpSqliteDb): Promise<List[]> {
  const { rows } = await db.execute('SELECT * FROM lists ORDER BY updated_at DESC');
  return ((rows ?? []) as unknown as ListRow[]).map(toList);
}

export async function addListItem(
  db: OpSqliteDb,
  listId: string,
  text: string,
  options?: { id?: string },
): Promise<ListItem> {
  const id = options?.id ?? generateId();
  const outcome=await runLocalOperation(db,{ operationId:generateId(),request:{ action:'addListItem',id,listId,text },execute:async(tx)=>{
    const created=await addListItemInTransaction(tx,{ id,listId,text });
    return { result:created.item,events:created.events };
  }});
  return outcome.result;
}

export async function addListItemInTransaction(tx:OpSqliteExecutor,input:{ id:string;listId:string;text:string;position?:number }):Promise<{ item:ListItem;events:JournalEvent[] }> {
  const timestamp=nowIso();
  const item:ListItem={ id:input.id,listId:input.listId,text:input.text,checked:false,position:input.position ?? 0,rev:1,createdAt:timestamp,updatedAt:timestamp };
  await tx.execute('INSERT INTO list_items (id,list_id,text,checked,position,rev,created_at,updated_at) VALUES (?,?,?,0,?,1,?,?)',
    [item.id,item.listId,item.text,item.position,timestamp,timestamp]);
  await markDirty(tx,'listItem',item.id,false);
  return { item,events:[{ entityType:'listItem',entityId:item.id,mutation:'upsert',payload:item }] };
}

export async function updateListItemInTransaction(tx:OpSqliteExecutor,id:string,patch:Partial<{ text:string;checked:boolean;position:number }>):Promise<{ item:ListItem;events:JournalEvent[] }> {
  const { rows }=await tx.execute('SELECT * FROM list_items WHERE id=?',[id]);
  if (!rows?.[0]) throw new Error(`List item not found: ${id}`);
  const existing=toListItem(rows[0] as unknown as ListItemRow);
  const item:ListItem={ ...existing,...(patch.text!==undefined?{text:patch.text}:{}),...(patch.checked!==undefined?{checked:patch.checked}:{}),
    ...(patch.position!==undefined?{position:patch.position}:{}),rev:existing.rev+1,updatedAt:nowIso() };
  await tx.execute('UPDATE list_items SET text=?,checked=?,position=?,rev=?,updated_at=? WHERE id=?',
    [item.text,item.checked?1:0,item.position,item.rev,item.updatedAt,id]);
  await markDirty(tx,'listItem',id,false);
  return { item,events:[{ entityType:'listItem',entityId:id,mutation:'upsert',payload:item }] };
}

export async function updateListItem(
  db: OpSqliteDb,
  id: string,
  patch: Partial<{ text: string; checked: boolean }>,
): Promise<ListItem> {
  const outcome=await runLocalOperation(db,{ operationId:generateId(),request:{ action:'updateListItem',id,patch },execute:async(tx)=>{
    const updated=await updateListItemInTransaction(tx,id,patch);
    return { result:updated.item,events:updated.events };
  }});
  return outcome.result;
}

export async function deleteListItemInTransaction(tx:OpSqliteExecutor,id:string):Promise<JournalEvent[]> {
  const { rows }=await tx.execute('SELECT id FROM list_items WHERE id=?',[id]);
  if (!rows?.length) throw new Error(`List item not found: ${id}`);
  await tx.execute('DELETE FROM list_items WHERE id=?',[id]);
  await markDirty(tx,'listItem',id,true);
  return [{ entityType:'listItem',entityId:id,mutation:'delete' }];
}

export async function deleteListItem(db: OpSqliteDb, id: string): Promise<void> {
  await runLocalOperation(db,{ operationId:generateId(),request:{ action:'deleteListItem',id },execute:async(tx)=>{
    const events=await deleteListItemInTransaction(tx,id);
    return { result:{ status:'deleted' },events };
  }});
}

export async function listItemsForList(db: OpSqliteDb, listId: string): Promise<ListItem[]> {
  const { rows } = await db.execute('SELECT * FROM list_items WHERE list_id = ? ORDER BY created_at ASC', [listId]);
  return ((rows ?? []) as unknown as ListItemRow[]).map(toListItem);
}
