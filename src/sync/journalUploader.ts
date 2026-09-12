import type {OpSqliteDb} from '../db/connection';
import {generateId} from '../data/id';
import type {InstallationKeyProvider} from '../security/installationKeys';

const JOURNAL_PATH='/yunote/installations/journal-batch';
const MAX_BODY_BYTES=96*1024;
const MAX_REVISIONS=100;
const MAX_EVENTS=500;

type JournalEntityType='class'|'note'|'list'|'listItem';
type JournalMutation='upsert'|'delete';

interface JournalRow {
  dataset_revision:number;
  sequence:number;
  operation_id:string;
  entity_type:JournalEntityType;
  entity_id:string;
  mutation:JournalMutation;
  payload_json:string|null;
}

interface InstallationRow {
  status:'pending'|'enrolled';
  installation_id:string;
  key_alias:string;
  key_version:number;
  replica_id:string;
  generation:number;
  applied_revision:number;
}

interface JournalRequestInit {method:'POST';headers:Record<string,string>;body:string}
interface JournalHttpResponse {status:number;json():Promise<unknown>}
type JournalRequest=(url:string,init:JournalRequestInit)=>Promise<JournalHttpResponse>;

export type JournalFlushOutcome=
  | {status:'not-enrolled'}
  | {status:'idle'}
  | {status:'uploaded';ackRevision:number};

function utf8ByteLength(value:string):number {
  let bytes=0;
  for(let index=0;index<value.length;index++){
    const code=value.charCodeAt(index);
    if(code<0x80)bytes+=1;
    else if(code<0x800)bytes+=2;
    else if(code>=0xd800&&code<=0xdbff&&index+1<value.length&&value.charCodeAt(index+1)>=0xdc00&&value.charCodeAt(index+1)<=0xdfff){bytes+=4;index++;}
    else bytes+=3;
  }
  return bytes;
}

function eventFromRow(row:JournalRow):Record<string,unknown> {
  const event:Record<string,unknown>={
    revision:row.dataset_revision,
    sequence:row.sequence,
    operationId:row.operation_id,
    entityType:row.entity_type,
    entityId:row.entity_id,
    mutation:row.mutation,
  };
  if(row.mutation==='upsert'){
    if(row.payload_json===null)throw new Error('Journal upsert is missing its payload');
    event.payload=JSON.parse(row.payload_json) as unknown;
  }else if(row.payload_json!==null){
    throw new Error('Journal delete unexpectedly contains a payload');
  }
  return event;
}

function parseAck(value:unknown,toRevision:number):number {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Journal upload response is malformed');
  const reply=value as Record<string,unknown>;
  if((reply.status!=='applied'&&reply.status!=='replayed')||reply.ackRevision!==toRevision)
    throw new Error('Journal upload acknowledgement does not match the sent batch');
  return toRevision;
}

export function createJournalUploader(deps:{
  db:OpSqliteDb;
  keyProvider:InstallationKeyProvider;
  digestUtf8?:(value:string)=>Promise<string>;
  baseUrl:string;
  request?:JournalRequest;
  now?:()=>number;
  generateNonce?:()=>string;
}) {
  if(!/^https:\/\//i.test(deps.baseUrl))throw new Error('Direct journal upload requires an HTTPS endpoint');
  const baseUrl=deps.baseUrl.replace(/\/$/,'');
  const request:JournalRequest=deps.request??(async(url,init)=>fetch(url,init));
  const digest=deps.digestUtf8??(value=>deps.keyProvider.sha256Utf8(value));
  const now=deps.now??Date.now;
  const nonce=deps.generateNonce??(()=>generateId().replace(/-/g,''));
  let inFlight:Promise<JournalFlushOutcome>|undefined;

  async function flushOnce():Promise<JournalFlushOutcome>{
    const installation=(await deps.db.execute(`SELECT status,installation_id,key_alias,key_version,replica_id,generation,applied_revision
      FROM installation_identity WHERE singleton=1`)).rows?.[0] as unknown as InstallationRow|undefined;
    if(!installation||installation.status!=='enrolled')return {status:'not-enrolled'};

    const rows=((await deps.db.execute(`SELECT dataset_revision,sequence,operation_id,entity_type,entity_id,mutation,payload_json
      FROM mutation_journal WHERE dataset_revision>? ORDER BY dataset_revision,sequence LIMIT ?`,
      [installation.applied_revision,MAX_EVENTS+1])).rows??[]) as unknown as JournalRow[];
    if(rows.length===0)return {status:'idle'};

    const expectedFirst=installation.applied_revision+1;
    if(rows[0].dataset_revision!==expectedFirst)throw new Error(`Local journal has a revision gap at ${expectedFirst}`);
    const accepted:JournalRow[]=[];
    let toRevision=installation.applied_revision;
    let cursor=0;
    while(cursor<rows.length&&toRevision-installation.applied_revision<MAX_REVISIONS){
      const revision=rows[cursor].dataset_revision;
      if(revision!==toRevision+1)throw new Error(`Local journal has a revision gap at ${toRevision+1}`);
      const start=cursor;
      while(cursor<rows.length&&rows[cursor].dataset_revision===revision)cursor++;
      const group=rows.slice(start,cursor);
      if(accepted.length+group.length>MAX_EVENTS)break;
      const candidate=[...accepted,...group];
      const candidateBody=JSON.stringify({replicaId:installation.replica_id,generation:installation.generation,
        fromRevision:expectedFirst,toRevision:revision,events:candidate.map(eventFromRow)});
      if(utf8ByteLength(candidateBody)>MAX_BODY_BYTES){
        if(accepted.length===0)throw new Error(`Journal revision ${revision} exceeds the direct upload limit`);
        break;
      }
      accepted.push(...group);
      toRevision=revision;
    }
    if(accepted.length===0)throw new Error('Journal batch could not include a complete revision');

    const body=JSON.stringify({replicaId:installation.replica_id,generation:installation.generation,
      fromRevision:expectedFirst,toRevision,events:accepted.map(eventFromRow)});
    const timestamp=String(now());
    const requestNonce=nonce();
    const bodyHash=await digest(body);
    const canonical=['YUNOTE-SIGNED-REQUEST-V1','POST',JOURNAL_PATH,bodyHash,installation.installation_id,
      String(installation.key_version),timestamp,requestNonce].join('\n');
    const signature=await deps.keyProvider.signUtf8(installation.key_alias,canonical);
    const response=await request(`${baseUrl}${JOURNAL_PATH}`,{method:'POST',headers:{
      'content-type':'application/json',
      'x-yunote-installation-id':installation.installation_id,
      'x-yunote-key-version':String(installation.key_version),
      'x-yunote-timestamp':timestamp,
      'x-yunote-nonce':requestNonce,
      'x-yunote-signature':signature,
    },body});
    const reply=await response.json();
    if(response.status!==200)throw new Error(`Journal upload failed with status ${response.status}`);
    const ackRevision=parseAck(reply,toRevision);
    await deps.db.transaction(async tx=>{
      const current=(await tx.execute('SELECT status,applied_revision FROM installation_identity WHERE singleton=1')).rows?.[0] as {status:string;applied_revision:number}|undefined;
      if(!current||current.status!=='enrolled'||current.applied_revision!==installation.applied_revision)
        throw new Error('Journal upload cursor changed while the batch was in flight');
      await tx.execute('UPDATE installation_identity SET applied_revision=? WHERE singleton=1 AND status=\'enrolled\' AND applied_revision=?',
        [ackRevision,installation.applied_revision]);
    });
    return {status:'uploaded',ackRevision};
  }

  return {
    flush():Promise<JournalFlushOutcome>{
      if(!inFlight)inFlight=flushOnce().finally(()=>{inFlight=undefined;});
      return inFlight;
    },
  };
}
