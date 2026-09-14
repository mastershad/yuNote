import type { OpSqliteDb, OpSqliteExecutor } from '../db/connection';
import { generateId, nowIso } from './id';
import { markDirty } from './syncOutbox';
import { runLocalOperation, type JournalEvent } from './localOperation';
import {applyCollaborativeListOperation,findCollaborativeList} from './collaborativeListOperations';

export type ListPurpose='generic'|'shopping';
export type SharingMode='personal'|'shared'|'partner';
export type CollaborationRole='owner'|'admin'|'editor'|'viewer'|'partner';

export interface List {
  id: string;
  title: string;
  classId:string|null;
  position:number;
  purpose:ListPurpose;
  sharingMode:SharingMode;
  sharedRevision:number|null;
  collaborationRole:CollaborationRole|null;
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
  completedByPublicClientId:string|null;
  completedByDisplayName:string|null;
  completedByHasAvatar:boolean;
  completedByAvatarVersion:number|null;
  completedByAvatarDataUri:string|null;
}

interface ListRow {
  id: string;
  title: string;
  class_id:string|null;
  position:number;
  purpose:ListPurpose;
  sharing_mode:SharingMode;
  shared_revision:number|null;
  collaboration_role:CollaborationRole|null;
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
  completed_by_public_client_id:string|null;
  completed_by_display_name:string|null;
  completed_by_has_avatar:number|null;
  completed_by_avatar_version:number|null;
  completion_avatar_mime_type?:string|null;
  completion_avatar_base64?:string|null;
}

function toList(row: ListRow): List {
  return { id:row.id,title:row.title,classId:row.class_id,position:row.position,purpose:row.purpose,sharingMode:row.sharing_mode,
    sharedRevision:row.shared_revision,collaborationRole:row.collaboration_role,rev:row.rev,createdAt:row.created_at,updatedAt:row.updated_at };
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
    completedByPublicClientId:row.completed_by_public_client_id,
    completedByDisplayName:row.completed_by_display_name,
    completedByHasAvatar:row.completed_by_has_avatar===1,
    completedByAvatarVersion:row.completed_by_avatar_version,
    completedByAvatarDataUri:row.completion_avatar_mime_type&&row.completion_avatar_base64?`data:${row.completion_avatar_mime_type};base64,${row.completion_avatar_base64}`:null,
  };
}

export async function createListInTransaction(tx:OpSqliteExecutor,input:{ id:string;title:string;classId:string|null;position?:number;purpose?:ListPurpose }):Promise<{ list:List;events:JournalEvent[] }> {
  const timestamp=nowIso();
  const list:List={ id:input.id,title:input.title,classId:input.classId,position:input.position ?? 0,purpose:input.purpose??'generic',sharingMode:'personal',sharedRevision:null,collaborationRole:null,rev:1,createdAt:timestamp,updatedAt:timestamp };
  await tx.execute("INSERT INTO lists (id,title,class_id,position,purpose,sharing_mode,shared_revision,collaboration_role,rev,created_at,updated_at) VALUES (?,?,?,?,?,'personal',NULL,NULL,1,?,?)",
    [list.id,list.title,list.classId,list.position,list.purpose,timestamp,timestamp]);
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
  const collaborative=await findCollaborativeList(db,{listId});
  if(collaborative){
    await applyCollaborativeListOperation(db,{operationId:generateId(),listId,type:'add_item',payload:{itemId:id,text}});
    return (await listItemsForList(db,listId)).find(item=>item.id===id)!;
  }
  const outcome=await runLocalOperation(db,{ operationId:generateId(),request:{ action:'addListItem',id,listId,text },execute:async(tx)=>{
    const created=await addListItemInTransaction(tx,{ id,listId,text });
    return { result:created.item,events:created.events };
  }});
  return outcome.result;
}

export async function addListItemInTransaction(tx:OpSqliteExecutor,input:{ id:string;listId:string;text:string;position?:number }):Promise<{ item:ListItem;events:JournalEvent[] }> {
  const timestamp=nowIso();
  const item:ListItem={ id:input.id,listId:input.listId,text:input.text,checked:false,position:input.position ?? 0,completedByPublicClientId:null,completedByDisplayName:null,completedByHasAvatar:false,completedByAvatarVersion:null,completedByAvatarDataUri:null,rev:1,createdAt:timestamp,updatedAt:timestamp };
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
  const collaborative=await findCollaborativeList(db,{itemId:id});
  if(collaborative){
    if(patch.text!==undefined)await applyCollaborativeListOperation(db,{operationId:generateId(),listId:collaborative.id,type:'update_item',payload:{itemId:id,text:patch.text}});
    if(patch.checked!==undefined)await applyCollaborativeListOperation(db,{operationId:generateId(),listId:collaborative.id,type:'set_checked',payload:{itemId:id,checked:patch.checked}});
    return (await listItemsForList(db,collaborative.id)).find(item=>item.id===id)!;
  }
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
  const collaborative=await findCollaborativeList(db,{itemId:id});
  if(collaborative){await applyCollaborativeListOperation(db,{operationId:generateId(),listId:collaborative.id,type:'delete_item',payload:{itemId:id}});return;}
  await runLocalOperation(db,{ operationId:generateId(),request:{ action:'deleteListItem',id },execute:async(tx)=>{
    const events=await deleteListItemInTransaction(tx,id);
    return { result:{ status:'deleted' },events };
  }});
}

export async function listItemsForList(db: OpSqliteDb, listId: string): Promise<ListItem[]> {
  const { rows } = await db.execute(`SELECT i.*,m.avatar_mime_type AS completion_avatar_mime_type,m.avatar_base64 AS completion_avatar_base64
    FROM list_items i LEFT JOIN collaboration_members m
      ON m.list_id=i.list_id AND m.public_client_id=i.completed_by_public_client_id
    WHERE i.list_id = ? ORDER BY i.created_at ASC`, [listId]);
  return ((rows ?? []) as unknown as ListItemRow[]).map(toListItem);
}
