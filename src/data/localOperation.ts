import type { OpSqliteDb, OpSqliteExecutor } from '../db/connection';
import { nowIso } from './id';

type EntityType = 'class'|'note'|'list'|'listItem';
type MutationType = 'upsert'|'delete';

export interface JournalEvent {
  entityType:EntityType;
  entityId:string;
  mutation:MutationType;
  payload?:unknown;
}

export class OperationPayloadMismatchError extends Error {
  constructor(operationId:string) {
    super(`operationId was reused with a different request: ${operationId}`);
    this.name='OperationPayloadMismatchError';
  }
}

function canonicalJson(value:unknown,path='value'):string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${path} contains a non-finite number`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item,index)=>canonicalJson(item,`${path}[${index}]`)).join(',')}]`;
  if (typeof value === 'object') {
    const record=value as Record<string,unknown>;
    const keys=Object.keys(record).sort();
    return `{${keys.map((key)=>`${JSON.stringify(key)}:${canonicalJson(record[key],`${path}.${key}`)}`).join(',')}}`;
  }
  throw new Error(`${path} is not JSON-serializable`);
}

interface StoredOperationRow {
  request_json:string;
  result_json:string;
  dataset_revision:number;
}

export async function runLocalOperation<T>(db:OpSqliteDb,input:{
  operationId:string;
  request:unknown;
  execute:(tx:OpSqliteExecutor)=>Promise<{ result:T; events:JournalEvent[] }>;
}):Promise<{ replayed:boolean; revision:number; result:T }> {
  if (input.operationId.trim().length===0) throw new Error('operationId must not be empty');
  const requestJson=canonicalJson(input.request,'request');

  let outcome:{ replayed:boolean; revision:number; result:T }|undefined;
  await db.transaction(async(tx)=>{
    const existing=(await tx.execute(
      'SELECT request_json,result_json,dataset_revision FROM applied_operations WHERE operation_id = ?',
      [input.operationId],
    )).rows?.[0] as unknown as StoredOperationRow|undefined;
    if (existing) {
      if (existing.request_json!==requestJson) throw new OperationPayloadMismatchError(input.operationId);
      outcome={ replayed:true, revision:existing.dataset_revision, result:JSON.parse(existing.result_json) as T };
      return;
    }

    const state=(await tx.execute('SELECT revision FROM dataset_state WHERE singleton = 1')).rows?.[0] as { revision:number }|undefined;
    if (!state) throw new Error('dataset state is missing');
    const revision=state.revision+1;
    const executed=await input.execute(tx);
    if (executed.events.length===0) throw new Error('local operation must emit at least one journal event');
    const resultJson=canonicalJson(executed.result,'result');
    const createdAt=nowIso();

    await tx.execute(
      'INSERT INTO applied_operations (operation_id,request_json,result_json,dataset_revision,created_at) VALUES (?,?,?,?,?)',
      [input.operationId,requestJson,resultJson,revision,createdAt],
    );
    let journalSequence=0;
    for (let index=0;index<executed.events.length;index++) {
      const event=executed.events[index];
      if (event.entityId.trim().length===0) throw new Error('journal entityId must not be empty');
      if (event.mutation==='upsert' && event.payload===undefined) throw new Error('journal upsert requires payload');
      if (event.mutation==='delete' && event.payload!==undefined) throw new Error('journal delete must not contain payload');
      if (event.entityType==='class') continue; // Classes are outside the synchronized dataset boundary -- never written to mutation_journal, regardless of what else the same local operation touched.
      await tx.execute(
        `INSERT INTO mutation_journal
         (dataset_revision,sequence,operation_id,entity_type,entity_id,mutation,payload_json,created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        [revision,journalSequence,input.operationId,event.entityType,event.entityId,event.mutation,
          event.payload===undefined ? null : canonicalJson(event.payload,`events[${index}].payload`),createdAt],
      );
      journalSequence++;
    }
    await tx.execute('UPDATE dataset_state SET revision = ? WHERE singleton = 1',[revision]);
    outcome={ replayed:false, revision, result:executed.result };
  });
  if (!outcome) throw new Error('local operation completed without an outcome');
  return outcome;
}

// Deliberately not a second journal system: no operationId, no idempotency
// ledger, no events array. Its only job is to name a transaction as
// local-only at the call site -- for mutations that are outside the
// synchronized dataset boundary and must never touch dataset_state,
// mutation_journal, or applied_operations at all.
export async function runLocalOnlyTransaction<T>(
  db:OpSqliteDb,
  execute:(tx:OpSqliteExecutor)=>Promise<T>,
):Promise<T> {
  let result:T|undefined;
  await db.transaction(async(tx)=>{
    result=await execute(tx);
  });
  return result as T;
}
