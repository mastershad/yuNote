import type {OpSqliteDb} from '../db/connection';

export type CollaborativeOperationType='add_item'|'update_item'|'set_checked'|'delete_item';
export interface CollaborativeListState {id:string;sharing_mode:'shared'|'partner';shared_revision:number;collaboration_role:string}

export async function findCollaborativeList(db:OpSqliteDb,input:{listId?:string;itemId?:string}):Promise<CollaborativeListState|undefined>{
  if(input.listId)return (await db.execute("SELECT id,sharing_mode,shared_revision,collaboration_role FROM lists WHERE id=? AND sharing_mode!='personal'",[input.listId])).rows?.[0] as unknown as CollaborativeListState|undefined;
  if(input.itemId)return (await db.execute(`SELECT l.id,l.sharing_mode,l.shared_revision,l.collaboration_role FROM lists l JOIN list_items i ON i.list_id=l.id
    WHERE i.id=? AND l.sharing_mode!='personal'`,[input.itemId])).rows?.[0] as unknown as CollaborativeListState|undefined;
  return undefined;
}

export async function applyCollaborativeListOperation(db:OpSqliteDb,input:{operationId:string;listId:string;type:CollaborativeOperationType;payload:Record<string,unknown>}):Promise<void>{
  const payloadJson=JSON.stringify(input.payload);
  await db.transaction(async tx=>{
    const prior=(await tx.execute('SELECT list_id,operation_type,payload_json FROM collaboration_outbox WHERE operation_id=?',[input.operationId])).rows?.[0] as {list_id:string;operation_type:string;payload_json:string}|undefined;
    if(prior){if(prior.list_id!==input.listId||prior.operation_type!==input.type||prior.payload_json!==payloadJson)throw new Error(`operationId was reused with a different request: ${input.operationId}`);return;}
    const list=(await tx.execute("SELECT shared_revision,collaboration_role,sharing_mode FROM lists WHERE id=? AND sharing_mode!='personal'",[input.listId])).rows?.[0] as {shared_revision:number;collaboration_role:string;sharing_mode:string}|undefined;
    if(!list)throw new Error('collaborative list is missing');
    if(list.collaboration_role==='viewer')throw new Error('collaboration role is read-only');
    const itemId=typeof input.payload.itemId==='string'?input.payload.itemId:'';
    if(!itemId)throw new Error('collaborative item id is missing');
    const timestamp=new Date().toISOString();
    if(input.type==='add_item'){
      const itemText=typeof input.payload.text==='string'?input.payload.text:'';
      await tx.execute('INSERT INTO list_items (id,list_id,text,checked,position,rev,created_at,updated_at) VALUES (?,?,?,0,0,1,?,?)',[itemId,input.listId,itemText,timestamp,timestamp]);
    }else{
      const exists=(await tx.execute('SELECT 1 AS value FROM list_items WHERE id=? AND list_id=?',[itemId,input.listId])).rows?.[0];
      if(!exists)throw new Error(`List item not found: ${itemId}`);
      if(input.type==='update_item'){
        const itemText=typeof input.payload.text==='string'?input.payload.text:'';
        await tx.execute('UPDATE list_items SET text=?,rev=rev+1,updated_at=? WHERE id=? AND list_id=?',[itemText,timestamp,itemId,input.listId]);
      }else if(input.type==='set_checked'){
        if(typeof input.payload.checked!=='boolean')throw new Error('checked state is malformed');
        if(input.payload.checked&&list.sharing_mode==='shared'){
          const actor=(await tx.execute('SELECT public_client_id,display_name,has_avatar,avatar_version FROM collaboration_members WHERE list_id=? AND is_current_user=1',[input.listId])).rows?.[0] as {public_client_id:string;display_name:string|null;has_avatar:number;avatar_version:number}|undefined;
          if(!actor)throw new Error('current collaboration profile is missing');
          await tx.execute(`UPDATE list_items SET checked=1,completed_by_public_client_id=?,completed_by_display_name=?,completed_by_has_avatar=?,completed_by_avatar_version=?,rev=rev+1,updated_at=? WHERE id=? AND list_id=?`,[actor.public_client_id,actor.display_name,actor.has_avatar,actor.avatar_version,timestamp,itemId,input.listId]);
        }else await tx.execute(`UPDATE list_items SET checked=?,completed_by_public_client_id=NULL,completed_by_display_name=NULL,
          completed_by_has_avatar=NULL,completed_by_avatar_version=NULL,rev=rev+1,updated_at=? WHERE id=? AND list_id=?`,[input.payload.checked?1:0,timestamp,itemId,input.listId]);
      }else await tx.execute('DELETE FROM list_items WHERE id=? AND list_id=?',[itemId,input.listId]);
    }
    await tx.execute('UPDATE lists SET shared_revision=shared_revision+1,updated_at=? WHERE id=?',[timestamp,input.listId]);
    await tx.execute(`INSERT INTO collaboration_outbox (operation_id,list_id,expected_revision,operation_type,payload_json,status,created_at)
      VALUES (?,?,?,?,?,'pending',?)`,[input.operationId,input.listId,list.shared_revision,input.type,payloadJson,timestamp]);
  });
}
