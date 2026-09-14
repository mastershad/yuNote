import type {OpSqliteDb} from '../db/connection';
import {generateId} from '../data/id';
import type {InstallationKeyProvider} from '../security/installationKeys';

const OPERATIONS_PATH='/yunote/installations/collaboration/operations';
interface InstallationRow {status:string;installation_id:string;key_alias:string;key_version:number}
interface HttpResponse {status:number;json():Promise<unknown>}
type Request=(url:string,init:{method:'POST';headers:Record<string,string>;body:string})=>Promise<HttpResponse>;
interface OutboxRow {operation_id:string;list_id:string;expected_revision:number;operation_type:string;payload_json:string}

export function createCollaborationOutbox(deps:{db:OpSqliteDb;keyProvider:InstallationKeyProvider;baseUrl:string;request?:Request;now?:()=>number;generateNonce?:()=>string}){
  if(!/^https:\/\//i.test(deps.baseUrl))throw new Error('Collaboration outbox requires an HTTPS endpoint');
  const baseUrl=deps.baseUrl.replace(/\/$/,'');
  const request:Request=deps.request??((url,init)=>fetch(url,init));
  const now=deps.now??Date.now;const nonce=deps.generateNonce??(()=>generateId().replace(/-/g,''));
  return {async flush():Promise<{status:'not-enrolled'|'idle'|'uploaded'|'conflict'|'discarded';operationId?:string}>{
    const installation=(await deps.db.execute('SELECT status,installation_id,key_alias,key_version FROM installation_identity WHERE singleton=1')).rows?.[0] as unknown as InstallationRow|undefined;
    if(!installation||installation.status!=='enrolled')return {status:'not-enrolled'};
    const row=(await deps.db.execute("SELECT operation_id,list_id,expected_revision,operation_type,payload_json FROM collaboration_outbox WHERE status='pending' ORDER BY expected_revision,created_at,operation_id LIMIT 1")).rows?.[0] as unknown as OutboxRow|undefined;
    if(!row)return {status:'idle'};
    const body=JSON.stringify({operationId:row.operation_id,listId:row.list_id,expectedRevision:row.expected_revision,type:row.operation_type,payload:JSON.parse(row.payload_json)});
    const timestamp=String(now());const requestNonce=nonce();const bodyHash=await deps.keyProvider.sha256Utf8(body);
    const canonical=['YUNOTE-SIGNED-REQUEST-V1','POST',OPERATIONS_PATH,bodyHash,installation.installation_id,String(installation.key_version),timestamp,requestNonce].join('\n');
    const response=await request(`${baseUrl}${OPERATIONS_PATH}`,{method:'POST',body,headers:{'content-type':'application/json',
      'x-yunote-installation-id':installation.installation_id,'x-yunote-key-version':String(installation.key_version),'x-yunote-timestamp':timestamp,
      'x-yunote-nonce':requestNonce,'x-yunote-signature':await deps.keyProvider.signUtf8(installation.key_alias,canonical)}});
    if(response.status===409){const conflict=await response.json() as {error?:unknown};if(conflict.error==='revision_conflict')return {status:'conflict',operationId:row.operation_id};}
    if(response.status===403){await deps.db.execute("UPDATE collaboration_outbox SET status='sent' WHERE list_id=? AND status='pending'",[row.list_id]);return {status:'discarded',operationId:row.operation_id};}
    if(response.status!==200)throw new Error(`Collaboration operation upload failed with status ${response.status}`);
    const reply=await response.json() as {status?:unknown;revision?:unknown};
    if(!['applied','replayed'].includes(String(reply.status))||reply.revision!==row.expected_revision+1)throw new Error('Collaboration operation response is malformed');
    await deps.db.execute("UPDATE collaboration_outbox SET status='sent',server_revision=? WHERE operation_id=? AND status='pending'",[reply.revision,row.operation_id]);
    return {status:'uploaded',operationId:row.operation_id};
  }};
}
