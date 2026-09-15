import type { OpSqliteDb } from '../db/connection';
import type { LocalTransport, LocalTransportMessage } from './localTransport';
import { createNoteInTransaction,updateNoteInTransaction,deleteNoteInTransaction } from '../data/notes';
import { createListInTransaction,addListItemInTransaction,updateListItemInTransaction,deleteListItemInTransaction } from '../data/lists';
import { runLocalOperation } from '../data/localOperation';
import { generateId } from '../data/id';
import {applyCollaborativeListOperation,findCollaborativeList} from '../data/collaborativeListOperations';
import {type HapticFeedback,androidVibrationFeedback} from './haptics';

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

/**
 * A short haptic pulse for content that just arrived from a Key Fob voice
 * capture -- never for an edit made directly in this app's own UI, which
 * never routes through applyStructuredAction. Restricted to the two verbs
 * that mean "something new landed": Capture (a new note or list item) and
 * Complete (an item got checked off). Modify/Remove/Clear are edits to
 * something already on screen, not an arrival.
 */
function pulseOnArrival(action: StructuredAction, result: ActionDispatchResult, haptics: HapticFeedback): void {
  if (result.status === 'applied' && (action.verb === 'Capture' || action.verb === 'Complete')) haptics.arrivalPulse();
}

async function collaborativeItemExists(db:OpSqliteDb,listId:string,itemId:string):Promise<boolean>{
  return (await db.execute('SELECT 1 AS value FROM list_items WHERE id=? AND list_id=?',[itemId,listId])).rows?.[0]!==undefined;
}

async function applyCollaborativeAction(db:OpSqliteDb,action:StructuredAction,operationId:string,list:{id:string;collaboration_role:string}):Promise<ActionDispatchResult>{
  if(list.collaboration_role==='viewer')return {status:'failed',reason:`${list.id}: collaboration role is read-only`};
  const type=action.verb==='Capture'?'add_item':action.verb==='Modify'?'update_item':action.verb==='Complete'?'set_checked':'delete_item';
  // A Clear names every item it removes. Each one is its own collaborative
  // operation (the outbox is keyed per item id, so a single operation carrying
  // one itemId would clear only one item of the list and leave the rest,
  // locally and for every other member).
  const itemIds=action.verb==='Clear'?(action.targetIds??[action.targetId]):[action.targetId];
  for(const itemId of itemIds){
    const payload:Record<string,unknown>={itemId};
    if(type==='add_item'||type==='update_item')payload.text=action.content??'';
    if(type==='set_checked')payload.checked=true;
    // Each Clear operation is keyed on its item, not on the item's position in
    // the request, so a redelivered Clear stays idempotent item by item even
    // when the set of items that still exist differs between the two attempts.
    try{
      await applyCollaborativeListOperation(db,{operationId:action.verb==='Clear'?`${operationId}#${itemId}`:operationId,listId:list.id,type,payload});
    }catch(error){
      // A Clear's goal for one item is that the item is gone, so an item a
      // co-member already deleted between the cloud's candidate snapshot and
      // this apply is already satisfied. Without this, that item's throw would
      // abort every item still queued behind it while leaving the ones already
      // applied committed -- and because redelivery is deterministic, the retry
      // would hit the same stale id and abort again, so the Clear could never
      // succeed and the items after it would be stranded permanently.
      // Existence is re-checked rather than matching on an error message, so a
      // genuine failure on an item that IS still there still propagates. The
      // tolerance is Clear-only: a single Remove of a missing item is a real
      // miss and still fails, unchanged.
      if(action.verb!=='Clear'||await collaborativeItemExists(db,list.id,itemId))throw error;
    }
  }
  return {status:'applied'};
}

export async function applyStructuredAction(db: OpSqliteDb, action: StructuredAction, operationId=generateId(), haptics: HapticFeedback = androidVibrationFeedback): Promise<ActionDispatchResult> {
  // The whitelist is also the reason no audio intention can administer a
  // collaborative list: only note and list-*item* content operations have a
  // dispatchable shape here, so invitations, role changes, ownership transfer,
  // membership revocation and list deletion -- cabinet-only per the
  // shared-and-partner-lists design spec §3 -- have nowhere to land.
  const supported=(action.targetType==='note' && ['Capture','Modify','Remove','Clear'].includes(action.verb)) ||
    (action.targetType==='listItem' && ['Capture','Modify','Complete','Remove','Clear'].includes(action.verb));
  if (!supported) return { status:'failed',reason:`unsupported targetType/verb combination: ${action.targetType}/${action.verb}` };
  try {
    // Resolve by the parent list whenever the cloud named one, and only fall
    // back to the item when it did not. Looking a Clear up by targetIds[0] made
    // whether the action counted as collaborative at all depend on that one
    // item still existing: a stale first id (a co-member deleted it) sent the
    // whole Clear down the personal path, and a redelivered Clear stopped being
    // collaborative the moment its own first item had been cleared.
    const collaboration=action.targetType==='listItem'
      ?await findCollaborativeList(db,action.parentListId?{listId:action.parentListId}:{itemId:action.targetId})
      :undefined;
    if(collaboration){const collabResult=await applyCollaborativeAction(db,action,operationId,collaboration);pulseOnArrival(action,collabResult,haptics);return collabResult;}
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
    // Only a fresh apply is an arrival -- a replayed operationId (the same
    // message redelivered) already pulsed the first time.
    if (!outcome.replayed) pulseOnArrival(action,outcome.result,haptics);
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
