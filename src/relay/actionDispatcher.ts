import type { OpSqliteDb } from '../db/connection';
import type { LocalTransport, LocalTransportMessage } from './localTransport';
import { createNoteInTransaction,updateNoteInTransaction,deleteNoteInTransaction } from '../data/notes';
import { createListInTransaction,addListItemInTransaction,updateListItemInTransaction,deleteListItemInTransaction } from '../data/lists';
import { runLocalOperation } from '../data/localOperation';
import { generateId } from '../data/id';
import {applyCollaborativeListOperation,findCollaborativeList} from '../data/collaborativeListOperations';

export interface StructuredAction {
  verb: 'Capture' | 'Modify' | 'Remove' | 'Complete' | 'Clear';
  targetType: 'note' | 'list' | 'listItem';
  targetId: string;
  targetIds?: string[];
  parentListId?: string;
  listName?: string;
  title?: string;
  content?: string;
  /** What kind of list Cloud Platform resolved the target inside. Used only as
   * a fail-closed cross-check (a collaborative target must never be written as
   * personal data) -- never as a grant: per the shared-and-partner-lists design
   * spec §8, a client-supplied sharing mode or role is ignored, and the role
   * that decides what may happen here is this installation's own membership
   * row. */
  sharingMode?: 'shared' | 'partner';
}

export type ActionDispatchResult = { status: 'applied' } | { status: 'failed'; reason: string };

async function applyCollaborativeAction(db:OpSqliteDb,action:StructuredAction,operationId:string,list:{id:string;collaboration_role:string}):Promise<ActionDispatchResult>{
  if(list.collaboration_role==='viewer')return {status:'failed',reason:`${list.id}: collaboration role is read-only`};
  const type=action.verb==='Capture'?'add_item':action.verb==='Modify'?'update_item':action.verb==='Complete'?'set_checked':'delete_item';
  // A Clear names every item it removes. Each one is its own collaborative
  // operation (the outbox is keyed per item id, so a single operation carrying
  // one itemId would clear only one item of the list and leave the rest,
  // locally and for every other member).
  const itemIds=action.verb==='Clear'?(action.targetIds??[action.targetId]):[action.targetId];
  for(const [index,itemId] of itemIds.entries()){
    const payload:Record<string,unknown>={itemId};
    if(type==='add_item'||type==='update_item')payload.text=action.content??'';
    if(type==='set_checked')payload.checked=true;
    // Per-item operation ids stay derived from the transfer id, so a redelivered
    // Clear is still idempotent item by item.
    await applyCollaborativeListOperation(db,{operationId:action.verb==='Clear'?`${operationId}#${index}`:operationId,listId:list.id,type,payload});
  }
  return {status:'applied'};
}

export async function applyStructuredAction(db: OpSqliteDb, action: StructuredAction, operationId=generateId()): Promise<ActionDispatchResult> {
  // The whitelist is also the reason no audio intention can administer a
  // collaborative list: only note and list-*item* content operations have a
  // dispatchable shape here, so invitations, role changes, ownership transfer,
  // membership revocation and list deletion -- cabinet-only per the
  // shared-and-partner-lists design spec §3 -- have nowhere to land.
  const supported=(action.targetType==='note' && ['Capture','Modify','Remove','Clear'].includes(action.verb)) ||
    (action.targetType==='listItem' && ['Capture','Modify','Complete','Remove','Clear'].includes(action.verb));
  if (!supported) return { status:'failed',reason:`unsupported targetType/verb combination: ${action.targetType}/${action.verb}` };
  try {
    const collaboration=action.targetType==='listItem'?await findCollaborativeList(db,action.verb==='Capture'?{listId:action.parentListId}:{itemId:action.targetId}):undefined;
    if(collaboration)return await applyCollaborativeAction(db,action,operationId,collaboration);
    // Cloud resolved a SHARED/PARTNER list but this installation has none --
    // the projection has not arrived yet, or the membership was revoked.
    // Falling through would write the item into personal data, which is the
    // exact misrouting this routing work exists to prevent.
    if(action.sharingMode)return {status:'failed',reason:`${action.parentListId??action.targetId}: cloud resolved a ${action.sharingMode} list, but no collaborative list is available locally`};
    const outcome=await runLocalOperation(db,{ operationId,request:action,execute:async(tx)=>{
      const events=[];
      if (action.targetType==='note') {
        if (action.verb==='Capture') {
          events.push(...(await createNoteInTransaction(tx,{ id:action.targetId,title:action.title ?? '',content:action.content ?? '',classId:null })).events);
        } else if (action.verb==='Modify') {
          events.push(...(await updateNoteInTransaction(tx,action.targetId,{ content:action.content ?? '' })).events);
        } else if (action.verb==='Remove') {
          events.push(...await deleteNoteInTransaction(tx,action.targetId));
        } else {
          for (const id of action.targetIds ?? [action.targetId]) events.push(...await deleteNoteInTransaction(tx,id));
        }
      } else if (action.verb==='Capture') {
        const parentListId=action.parentListId ?? '';
        if (action.listName!==undefined) events.push(...(await createListInTransaction(tx,{ id:parentListId,title:action.listName,classId:null })).events);
        events.push(...(await addListItemInTransaction(tx,{ id:action.targetId,listId:parentListId,text:action.content ?? '' })).events);
      } else if (action.verb==='Modify') {
        events.push(...(await updateListItemInTransaction(tx,action.targetId,{ text:action.content ?? '' })).events);
      } else if (action.verb==='Complete') {
        events.push(...(await updateListItemInTransaction(tx,action.targetId,{ checked:true })).events);
      } else if (action.verb==='Remove') {
        events.push(...await deleteListItemInTransaction(tx,action.targetId));
      } else {
        for (const id of action.targetIds ?? [action.targetId]) events.push(...await deleteListItemInTransaction(tx,id));
      }
      return { result:{ status:'applied' as const },events };
    }});
    return outcome.result;
  } catch (error) {
    // A repository function throws when it can't find the row it was asked
    // to update/delete (design spec §9: "Structured Action targets an id
    // that no longer exists locally... treats this as a no-op + logs, does
    // not crash"). Surfacing the real error message keeps this diagnosable
    // without needing a crash to see it.
    const message = error instanceof Error ? error.message : String(error);
    return { status: 'failed', reason: `${action.targetId}: ${message}` };
  }
}

export function registerActionDispatcher(db: OpSqliteDb, transport: LocalTransport): () => void {
  return transport.onReceive(async (message: LocalTransportMessage) => {
    if (message.kind !== 'structured-action') {
      return;
    }
    if (typeof message.small !== 'object' || message.small === null) {
      // Guard against an absent/malformed payload before it ever reaches
      // applyStructuredAction: without this, `action.targetType` throws once
      // inside applyStructuredAction's own try block, then the catch block's
      // error-message construction (`${action.targetId}: ...`) throws AGAIN
      // on the same invalid value -- a throw that escapes applyStructuredAction
      // entirely, rejects this handler's promise, and can abort other
      // handlers registered on the same transport (registerSyncHandlers is
      // now registered alongside this one in real usage). Mirrors
      // applyStructuredAction's own {status: 'failed', reason} shape for a
      // recoverable failure, without ever touching action.targetId or
      // calling applyStructuredAction at all:
      // { status: 'failed', reason: 'malformed structured-action payload' }
      await transport.acknowledge(message.transferId);
      return;
    }
    await applyStructuredAction(db, message.small as unknown as StructuredAction, message.transferId);
    // Acknowledged regardless of whether the action itself applied or
    // failed: the *message* was received and handled either way. A
    // permanently-failed action (target no longer exists) surfaces to
    // Key Fob as a sync-error via a separate mechanism (this plan's Task 5
    // does not build that reporting path yet -- see the plan's own
    // Self-Review Notes), not by leaving the message stuck retrying
    // forever.
    await transport.acknowledge(message.transferId);
  });
}
