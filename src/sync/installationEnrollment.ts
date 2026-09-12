import type {OpSqliteDb} from '../db/connection';
import type {InstallationKeyProvider} from '../security/installationKeys';
import {generateId,nowIso} from '../data/id';

const TOKEN=/^[0-9a-f]{64}$/i;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REPLICA=/^[0-9a-f]{32}$/i;

interface EnrollmentHttpResponse {status:number;json():Promise<unknown>}
interface EnrollmentRequestInit {method:'POST';headers:Record<string,string>;body:string}
type EnrollmentRequest=(url:string,init:EnrollmentRequestInit)=>Promise<EnrollmentHttpResponse>;

export interface EnrollmentMetadata {
  status:'pending'|'enrolled';installationId:string;keyAlias:string;keyVersion:number;
  bindingId:string|null;replicaId:string;generation:number;appliedRevision:number;cloudBaseUrl:string|null;
}

interface EnrollmentReply {installationId:string;bindingId:string;replicaId:string;generation:number;keyVersion:number;appliedRevision:number}

function parseReply(value:unknown):EnrollmentReply|undefined {
  if(!value||typeof value!=='object'||Array.isArray(value))return undefined;
  const v=value as Record<string,unknown>;
  if(typeof v.installationId!=='string'||!UUID.test(v.installationId)||typeof v.bindingId!=='string'||v.bindingId.length<1||v.bindingId.length>128||
    typeof v.replicaId!=='string'||!REPLICA.test(v.replicaId)||!Number.isSafeInteger(v.generation)||!Number.isSafeInteger(v.keyVersion)||!Number.isSafeInteger(v.appliedRevision)||
    (v.generation as number)<1||(v.keyVersion as number)<1||(v.appliedRevision as number)<0)return undefined;
  return v as unknown as EnrollmentReply;
}

function rowToMetadata(row:Record<string,unknown>):EnrollmentMetadata {
  return {status:row.status as EnrollmentMetadata['status'],installationId:row.installation_id as string,keyAlias:row.key_alias as string,
    keyVersion:row.key_version as number,bindingId:row.binding_id as string|null,replicaId:row.replica_id as string,
    generation:row.generation as number,appliedRevision:row.applied_revision as number,cloudBaseUrl:row.cloud_base_url as string|null};
}

async function localSnapshotJson(db:OpSqliteDb):Promise<string>{
  const classes=(await db.execute('SELECT id,name,rev,created_at AS createdAt,updated_at AS updatedAt,position FROM classes ORDER BY position,id')).rows??[];
  const notes=(await db.execute('SELECT id,title,content,class_id AS classId,rev,created_at AS createdAt,updated_at AS updatedAt,position FROM notes ORDER BY position,id')).rows??[];
  const lists=(await db.execute('SELECT id,title,class_id AS classId,rev,created_at AS createdAt,updated_at AS updatedAt,position FROM lists ORDER BY position,id')).rows??[];
  const itemRows=(await db.execute('SELECT id,list_id AS listId,text,checked,rev,created_at AS createdAt,updated_at AS updatedAt,position FROM list_items ORDER BY position,id')).rows??[];
  const listItems=itemRows.map(row=>({...row,checked:row.checked===1}));
  return JSON.stringify({schemaVersion:1,classes,notes,lists,listItems});
}

export function createInstallationEnrollmentClient(deps:{db:OpSqliteDb;keyProvider:InstallationKeyProvider;baseUrl:string;request?:EnrollmentRequest;generateId?:()=>string;now?:()=>string}) {
  if(!/^https:\/\//i.test(deps.baseUrl))throw new Error('Installation enrollment requires an HTTPS endpoint');
  const request:EnrollmentRequest=deps.request??(async(url,init)=>fetch(url,init));
  const baseUrl=deps.baseUrl.replace(/\/$/,'');
  const id=deps.generateId??generateId;const currentTime=deps.now??nowIso;
  return {
    async getMetadata():Promise<EnrollmentMetadata|undefined>{
      const row=(await deps.db.execute('SELECT status,installation_id,key_alias,key_version,binding_id,replica_id,generation,applied_revision,cloud_base_url FROM installation_identity WHERE singleton = 1')).rows?.[0];
      return row?rowToMetadata(row):undefined;
    },
    async enroll(token:string):Promise<EnrollmentMetadata>{
      if(!TOKEN.test(token))throw new Error('Pairing token is invalid');
      let metadata=await this.getMetadata();
      if(metadata?.status==='enrolled')throw new Error('This yuNote installation is already enrolled');
      if(!metadata){
        const dataset=(await deps.db.execute('SELECT replica_id,generation FROM dataset_state WHERE singleton = 1')).rows?.[0];
        if(!dataset||typeof dataset.replica_id!=='string'||typeof dataset.generation!=='number')throw new Error('Local dataset identity is unavailable');
        const installationId=id();if(!UUID.test(installationId))throw new Error('Generated installation id is invalid');
        const keyAlias=`yunote-installation-${installationId}`;
        await deps.db.execute(`INSERT INTO installation_identity
          (singleton,status,installation_id,key_alias,key_version,binding_id,replica_id,generation,applied_revision,created_at,enrolled_at,cloud_base_url)
          VALUES (1,'pending',?,?,1,NULL,?,?,0,?,NULL,?)`,[installationId,keyAlias,dataset.replica_id,dataset.generation,currentTime(),baseUrl]);
        metadata={status:'pending',installationId,keyAlias,keyVersion:1,bindingId:null,replicaId:dataset.replica_id,generation:dataset.generation,appliedRevision:0,cloudBaseUrl:baseUrl};
      } else if(metadata.cloudBaseUrl===null) {
        await deps.db.execute("UPDATE installation_identity SET cloud_base_url=? WHERE singleton=1 AND status='pending' AND cloud_base_url IS NULL",[baseUrl]);
        metadata={...metadata,cloudBaseUrl:baseUrl};
      } else if(metadata.cloudBaseUrl!==baseUrl) {
        throw new Error('Pending installation is bound to a different cloud endpoint');
      }
      const {publicKeyPem}=await deps.keyProvider.ensureKey(metadata.keyAlias);
      const dataset=(await deps.db.execute('SELECT revision FROM dataset_state WHERE singleton = 1')).rows?.[0];
      if(!dataset||typeof dataset.revision!=='number')throw new Error('Local dataset revision is unavailable');
      const snapshotHash=await deps.keyProvider.sha256Utf8(await localSnapshotJson(deps.db));
      const response=await request(`${baseUrl}/yunote/installations/enroll`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
        token,installationId:metadata.installationId,publicKeyPem,keyVersion:metadata.keyVersion,replicaId:metadata.replicaId,generation:metadata.generation,
        datasetRevision:dataset.revision,snapshotHash,
      })});
      const reply=parseReply(await response.json());
      if(response.status!==201||!reply)throw new Error(`Installation enrollment failed with status ${response.status}`);
      if(reply.installationId!==metadata.installationId||reply.replicaId!==metadata.replicaId||reply.generation!==metadata.generation||reply.keyVersion!==metadata.keyVersion)
        throw new Error('Installation enrollment response does not match the local identity');
      await deps.db.execute(`UPDATE installation_identity SET status='enrolled',binding_id=?,applied_revision=?,enrolled_at=?
        WHERE singleton=1 AND status='pending'`,[reply.bindingId,reply.appliedRevision,currentTime()]);
      return {...metadata,status:'enrolled',bindingId:reply.bindingId,appliedRevision:reply.appliedRevision};
    },
  };
}
