import type { OpSqliteDb, OpSqliteExecutor } from '../db/connection';
import { generateId } from '../data/id';
import type { InstallationKeyProvider } from '../security/installationKeys';

const INBOX_PATH='/yunote/installations/collaboration/inbox?limit=50';
const ACK_PATH='/yunote/installations/collaboration/ack';

interface InstallationRow {status:string;installation_id:string;key_alias:string;key_version:number}
interface PublicProfile {publicClientId:string;displayName:string|null;hasAvatar:boolean;avatarVersion?:number}
interface Delivery {
  sequence:number;operationId:string;listId:string;revision:number;
  type:'add_item'|'update_item'|'set_checked'|'delete_item'|'replace_projection'|'remove_projection'|'discard';
  payload:Record<string,unknown>;actor?:PublicProfile;
}
interface HttpResponse {status:number;json():Promise<unknown>}
type Request=(url:string,init:{method:'GET'|'POST';headers:Record<string,string>;body?:string})=>Promise<HttpResponse>;

function object(value:unknown,name:string):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error(`${name} is malformed`);
  return value as Record<string,unknown>;
}
function text(value:unknown,name:string):string{
  if(typeof value!=='string'||value.length<1||value.length>500)throw new Error(`${name} is malformed`);
  return value;
}
function integer(value:unknown,name:string):number{
  if(!Number.isSafeInteger(value)||Number(value)<0)throw new Error(`${name} is malformed`);
  return Number(value);
}

async function replaceProjection(tx:OpSqliteExecutor,payload:Record<string,unknown>):Promise<void>{
  const list=object(payload.list,'projection list');
  const id=text(list.id,'list id');
  const sharingMode=list.sharingMode;
  const purpose=list.purpose;
  const role=list.role;
  if(!['personal','shared','partner'].includes(String(sharingMode))||!['generic','shopping'].includes(String(purpose))||
    (sharingMode!=='personal'&&!['owner','admin','editor','viewer','partner'].includes(String(role))))throw new Error('projection capability is malformed');
  if(sharingMode==='partner'&&purpose!=='shopping')throw new Error('partner projection must be a Shopping List');
  const revision=integer(list.revision,'list revision');
  if(sharingMode==='partner'&&payload.removePersonalShoppingListId!==undefined){
    const sourceId=text(payload.removePersonalShoppingListId,'personal Shopping List id');
    if(sourceId===id)throw new Error('partner projection source matches destination');
    const source=(await tx.execute('SELECT purpose,sharing_mode FROM lists WHERE id=?',[sourceId])).rows?.[0] as {purpose:string;sharing_mode:string}|undefined;
    if(source){
      if(source.purpose!=='shopping'||source.sharing_mode!=='personal')throw new Error('partner projection source is not a personal Shopping List');
      const sourceItems=(await tx.execute('SELECT id FROM list_items WHERE list_id=?',[sourceId])).rows??[];
      for(const row of sourceItems as Array<{id:string}>)await tx.execute("DELETE FROM sync_outbox WHERE entity_type='listItem' AND entity_id=?",[row.id]);
      await tx.execute("DELETE FROM sync_outbox WHERE entity_type='list' AND entity_id=?",[sourceId]);
      await tx.execute('DELETE FROM list_items WHERE list_id=?',[sourceId]);
      await tx.execute('DELETE FROM lists WHERE id=?',[sourceId]);
    }
  }
  await tx.execute('DELETE FROM collaboration_members WHERE list_id=?',[id]);
  await tx.execute('DELETE FROM list_items WHERE list_id=?',[id]);
  await tx.execute('DELETE FROM lists WHERE id=?',[id]);
  await tx.execute(`INSERT INTO lists
    (id,title,class_id,position,purpose,sharing_mode,shared_revision,collaboration_role,rev,created_at,updated_at)
    VALUES (?,?,NULL,0,?,?,?,?,?, ?,?)`,[id,text(list.title,'list title'),purpose,sharingMode,sharingMode==='personal'?null:revision,sharingMode==='personal'?null:role,sharingMode==='personal'?revision:1,new Date().toISOString(),new Date().toISOString()]);
  for(const rawMember of Array.isArray(payload.members)?payload.members:[]){
    const member=object(rawMember,'member');const profile=object(member.profile,'member profile');
    await tx.execute(`INSERT INTO collaboration_members
      (list_id,public_client_id,display_name,has_avatar,avatar_version,role,is_current_user) VALUES (?,?,?,?,?,?,?)`,
      [id,text(profile.publicClientId,'public client id'),typeof profile.displayName==='string'?profile.displayName:null,profile.hasAvatar?1:0,integer(profile.avatarVersion??0,'avatar version'),text(member.role,'member role'),member.isCurrentUser?1:0]);
  }
  for(const rawItem of Array.isArray(payload.items)?payload.items:[]){
    const item=object(rawItem,'projection item');const completed=item.completedBy?object(item.completedBy,'completion actor'):null;
    await tx.execute(`INSERT INTO list_items
      (id,list_id,text,checked,position,rev,created_at,updated_at,completed_by_public_client_id,completed_by_display_name,completed_by_has_avatar,completed_by_avatar_version)
      VALUES (?,?,?,?,0,?,?,?,?,?,?,?)`,[
      text(item.id,'item id'),id,text(item.text,'item text'),item.checked?1:0,integer(item.revision??1,'item revision'),new Date().toISOString(),new Date().toISOString(),
      completed?text(completed.publicClientId,'completion public id'):null,completed&&typeof completed.displayName==='string'?completed.displayName:null,
      completed?(completed.hasAvatar?1:0):null,completed?integer(completed.avatarVersion??0,'completion avatar version'):null,
    ]);
  }
  const pending=(await tx.execute("SELECT operation_id,operation_type,payload_json FROM collaboration_outbox WHERE list_id=? AND status='pending' ORDER BY expected_revision,created_at,operation_id",[id])).rows??[];
  let rebasedRevision=revision;
  for(const raw of pending as Array<{operation_id:string;operation_type:string;payload_json:string}>){
    const operationPayload=object(JSON.parse(raw.payload_json),'pending collaboration operation');
    const itemId=text(operationPayload.itemId,'pending item id');const timestamp=new Date().toISOString();
    if(raw.operation_type==='add_item')await tx.execute('INSERT INTO list_items (id,list_id,text,checked,position,rev,created_at,updated_at) VALUES (?,?,?,0,0,1,?,?)',[itemId,id,text(operationPayload.text,'pending item text'),timestamp,timestamp]);
    else{
      const exists=(await tx.execute('SELECT 1 AS value FROM list_items WHERE id=? AND list_id=?',[itemId,id])).rows?.[0];
      if(!exists)throw new Error(`Pending collaboration target disappeared: ${itemId}`);
      if(raw.operation_type==='update_item')await tx.execute('UPDATE list_items SET text=?,rev=rev+1,updated_at=? WHERE id=?',[text(operationPayload.text,'pending item text'),timestamp,itemId]);
      else if(raw.operation_type==='set_checked'){
        if(typeof operationPayload.checked!=='boolean')throw new Error('pending checked state is malformed');
        if(operationPayload.checked&&sharingMode==='shared'){
          const actor=(await tx.execute('SELECT public_client_id,display_name,has_avatar,avatar_version FROM collaboration_members WHERE list_id=? AND is_current_user=1',[id])).rows?.[0] as {public_client_id:string;display_name:string|null;has_avatar:number;avatar_version:number}|undefined;
          if(!actor)throw new Error('current collaboration profile is missing during rebase');
          await tx.execute(`UPDATE list_items SET checked=1,completed_by_public_client_id=?,completed_by_display_name=?,completed_by_has_avatar=?,completed_by_avatar_version=?,rev=rev+1,updated_at=? WHERE id=?`,[actor.public_client_id,actor.display_name,actor.has_avatar,actor.avatar_version,timestamp,itemId]);
        }else await tx.execute(`UPDATE list_items SET checked=?,completed_by_public_client_id=NULL,completed_by_display_name=NULL,completed_by_has_avatar=NULL,completed_by_avatar_version=NULL,rev=rev+1,updated_at=? WHERE id=?`,[operationPayload.checked?1:0,timestamp,itemId]);
      }else if(raw.operation_type==='delete_item')await tx.execute('DELETE FROM list_items WHERE id=?',[itemId]);
      else throw new Error('pending collaboration operation type is malformed');
    }
    await tx.execute('UPDATE collaboration_outbox SET expected_revision=? WHERE operation_id=?',[rebasedRevision,raw.operation_id]);
    rebasedRevision+=1;
  }
  if(rebasedRevision!==revision)await tx.execute('UPDATE lists SET shared_revision=? WHERE id=?',[rebasedRevision,id]);
}

async function applyDelivery(tx:OpSqliteExecutor,delivery:Delivery):Promise<void>{
  if(delivery.type==='discard')return;
  if(delivery.type==='replace_projection'){await replaceProjection(tx,delivery.payload);return;}
  if(delivery.type==='remove_projection'){
    const removeListId=text(delivery.payload.removeListId,'removed list id');
    if(removeListId!==delivery.listId)throw new Error('removed projection id mismatch');
    await tx.execute('DELETE FROM collaboration_members WHERE list_id=?',[removeListId]);
    await tx.execute('DELETE FROM list_items WHERE list_id=?',[removeListId]);
    await tx.execute('DELETE FROM lists WHERE id=?',[removeListId]);
    if(delivery.payload.personalList)await replaceProjection(tx,{list:delivery.payload.personalList,items:delivery.payload.items});
    return;
  }
  const list=(await tx.execute('SELECT sharing_mode,shared_revision FROM lists WHERE id=?',[delivery.listId])).rows?.[0] as {sharing_mode:string;shared_revision:number|null}|undefined;
  if(!list||list.sharing_mode==='personal')throw new Error('collaboration list projection is missing');
  if(list.shared_revision!==delivery.revision-1)throw new Error('collaboration revision gap');
  const itemId=text(delivery.payload.itemId,'item id');
  if(delivery.type==='add_item'){
    await tx.execute(`INSERT INTO list_items (id,list_id,text,checked,position,rev,created_at,updated_at)
      VALUES (?,?,?,0,0,1,?,?)`,[itemId,delivery.listId,text(delivery.payload.text,'item text'),new Date().toISOString(),new Date().toISOString()]);
  }else if(delivery.type==='update_item'){
    await tx.execute('UPDATE list_items SET text=?,rev=rev+1,updated_at=? WHERE id=? AND list_id=?',
      [text(delivery.payload.text,'item text'),new Date().toISOString(),itemId,delivery.listId]);
  }else if(delivery.type==='set_checked'){
    if(typeof delivery.payload.checked!=='boolean')throw new Error('checked state is malformed');
    const completed=delivery.payload.checked&&list.sharing_mode==='shared'?delivery.actor:null;
    if(delivery.payload.checked&&list.sharing_mode==='shared'&&!completed)throw new Error('shared completion actor is missing');
    if(completed){
      const version=integer(completed.avatarVersion??0,'completion avatar version');
      await tx.execute(`UPDATE collaboration_members SET display_name=?,has_avatar=?,avatar_version=?,
        avatar_mime_type=CASE WHEN avatar_version=? THEN avatar_mime_type ELSE NULL END,
        avatar_base64=CASE WHEN avatar_version=? THEN avatar_base64 ELSE NULL END
        WHERE list_id=? AND public_client_id=?`,[completed.displayName,completed.hasAvatar?1:0,version,version,version,delivery.listId,completed.publicClientId]);
    }
    await tx.execute(`UPDATE list_items SET checked=?,completed_by_public_client_id=?,completed_by_display_name=?,
      completed_by_has_avatar=?,completed_by_avatar_version=?,rev=rev+1,updated_at=? WHERE id=? AND list_id=?`,[
      delivery.payload.checked?1:0,completed?.publicClientId??null,completed?.displayName??null,
      completed?(completed.hasAvatar?1:0):null,completed?.avatarVersion??null,new Date().toISOString(),itemId,delivery.listId]);
  }else await tx.execute('DELETE FROM list_items WHERE id=? AND list_id=?',[itemId,delivery.listId]);
  await tx.execute('UPDATE lists SET shared_revision=?,updated_at=? WHERE id=?',[delivery.revision,new Date().toISOString(),delivery.listId]);
}

export function createCollaborationInbox(deps:{db:OpSqliteDb;keyProvider:InstallationKeyProvider;baseUrl:string;request?:Request;now?:()=>number;generateNonce?:()=>string}){
  if(!/^https:\/\//i.test(deps.baseUrl))throw new Error('Collaboration inbox requires an HTTPS endpoint');
  const baseUrl=deps.baseUrl.replace(/\/$/,'');const request:Request=deps.request??((url,init)=>fetch(url,init));
  const now=deps.now??Date.now;const nonce=deps.generateNonce??(()=>generateId().replace(/-/g,''));
  const installation=async()=>{
    const row=(await deps.db.execute('SELECT status,installation_id,key_alias,key_version FROM installation_identity WHERE singleton=1')).rows?.[0] as unknown as InstallationRow|undefined;
    return row?.status==='enrolled'?row:undefined;
  };
  const signed=async(row:InstallationRow,method:'GET'|'POST',path:string,body='')=>{
    const timestamp=String(now());const requestNonce=nonce();const bodyHash=await deps.keyProvider.sha256Utf8(body);
    const canonical=['YUNOTE-SIGNED-REQUEST-V1',method,path,bodyHash,row.installation_id,String(row.key_version),timestamp,requestNonce].join('\n');
    return {'content-type':'application/json','x-yunote-installation-id':row.installation_id,'x-yunote-key-version':String(row.key_version),
      'x-yunote-timestamp':timestamp,'x-yunote-nonce':requestNonce,'x-yunote-signature':await deps.keyProvider.signUtf8(row.key_alias,canonical)};
  };
  return {async pollApplyAndAcknowledge():Promise<{status:'not-enrolled'|'idle'|'applied';count?:number}>{
    const row=await installation();if(!row)return {status:'not-enrolled'};
    const poll=await request(`${baseUrl}${INBOX_PATH}`,{method:'GET',headers:await signed(row,'GET',INBOX_PATH)});
    if(poll.status!==200)throw new Error(`Collaboration inbox poll failed with status ${poll.status}`);
    const reply=object(await poll.json(),'collaboration inbox response');
    if(!Array.isArray(reply.deliveries))throw new Error('collaboration deliveries are malformed');
    const deliveries=reply.deliveries as Delivery[];
    const cursorRow=(await deps.db.execute('SELECT acknowledged_sequence FROM collaboration_inbox_state WHERE singleton=1')).rows?.[0] as {acknowledged_sequence:number};
    let cursor=cursorRow.acknowledged_sequence;
    const fresh=deliveries.filter(delivery=>integer(delivery.sequence,'delivery sequence')>cursor);
    for(const delivery of fresh){if(delivery.sequence!==cursor+1)throw new Error(`Collaboration inbox gap at ${cursor+1}`);cursor=delivery.sequence;}
    if(fresh.length){
      const latestProjection=new Map<string,number>();
      for(const delivery of fresh)if(delivery.type==='replace_projection')latestProjection.set(delivery.listId,delivery.sequence);
      await deps.db.transaction(async tx=>{
        for(const delivery of fresh){
          const superseded=(latestProjection.get(delivery.listId)??0)>delivery.sequence&&['add_item','update_item','set_checked','delete_item'].includes(delivery.type);
          if(!superseded)await applyDelivery(tx,delivery);
        }
        await tx.execute('UPDATE collaboration_inbox_state SET acknowledged_sequence=? WHERE singleton=1',[cursor]);
      });
    }
    if(fresh.length){
      const avatarRows=(await deps.db.execute('SELECT list_id,public_client_id,avatar_version FROM collaboration_members WHERE has_avatar=1 AND avatar_base64 IS NULL')).rows??[];
      for(const avatarRow of avatarRows as Array<{list_id:string;public_client_id:string;avatar_version:number}>){
        const avatarPath=`/yunote/installations/collaboration/avatars/${encodeURIComponent(avatarRow.public_client_id)}`;
        const response=await request(`${baseUrl}${avatarPath}`,{method:'GET',headers:await signed(row,'GET',avatarPath)});
        if(response.status===404){await deps.db.execute('UPDATE collaboration_members SET has_avatar=0 WHERE list_id=? AND public_client_id=?',[avatarRow.list_id,avatarRow.public_client_id]);continue;}
        if(response.status!==200)throw new Error(`Collaboration avatar fetch failed with status ${response.status}`);
        const avatar=object(await response.json(),'collaboration avatar');
        if(!['image/jpeg','image/png','image/webp'].includes(String(avatar.mimeType))||typeof avatar.base64!=='string'||avatar.base64.length>700000||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(avatar.base64)||integer(avatar.avatarVersion,'avatar version')!==avatarRow.avatar_version)throw new Error('Collaboration avatar is malformed');
        await deps.db.execute('UPDATE collaboration_members SET avatar_mime_type=?,avatar_base64=? WHERE list_id=? AND public_client_id=?',
          [avatar.mimeType,avatar.base64,avatarRow.list_id,avatarRow.public_client_id]);
      }
    }
    if(cursor>0&&deliveries.length){
      const body=JSON.stringify({throughSequence:cursor});
      const ack=await request(`${baseUrl}${ACK_PATH}`,{method:'POST',headers:await signed(row,'POST',ACK_PATH,body),body});
      if(ack.status!==200)throw new Error(`Collaboration acknowledgement failed with status ${ack.status}`);
    }
    return fresh.length?{status:'applied',count:fresh.length}:{status:'idle'};
  }};
}
