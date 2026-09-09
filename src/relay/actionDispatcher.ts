import type { OpSqliteDb } from '../db/connection';
import type { LocalTransport, LocalTransportMessage } from './localTransport';
import { createNote, updateNote, deleteNote } from '../data/notes';
import { createList, addListItem, updateListItem, deleteListItem } from '../data/lists';

export interface StructuredAction {
  verb: 'Capture' | 'Modify' | 'Remove' | 'Complete' | 'Clear';
  targetType: 'note' | 'list' | 'listItem';
  targetId: string;
  targetIds?: string[];
  parentListId?: string;
  listName?: string;
  title?: string;
  content?: string;
}

export type ActionDispatchResult = { status: 'applied' } | { status: 'failed'; reason: string };

export async function applyStructuredAction(db: OpSqliteDb, action: StructuredAction): Promise<ActionDispatchResult> {
  try {
    if (action.targetType === 'note') {
      if (action.verb === 'Capture') {
        await createNote(db, { id: action.targetId, title: action.title ?? '', content: action.content ?? '' });
        return { status: 'applied' };
      }
      if (action.verb === 'Modify') {
        await updateNote(db, action.targetId, { content: action.content ?? '' });
        return { status: 'applied' };
      }
      if (action.verb === 'Remove') {
        await deleteNote(db, action.targetId);
        return { status: 'applied' };
      }
      if (action.verb === 'Clear') {
        for (const id of action.targetIds ?? [action.targetId]) {
          await deleteNote(db, id);
        }
        return { status: 'applied' };
      }
    }

    if (action.targetType === 'listItem') {
      if (action.verb === 'Capture') {
        // listName present means the parent list doesn't exist locally
        // yet -- create it first, using the server-provided parentListId
        // as its id, exactly like the item itself uses targetId.
        if (action.listName !== undefined) {
          await createList(db, action.listName, { id: action.parentListId });
        }
        await addListItem(db, action.parentListId ?? '', action.content ?? '', { id: action.targetId });
        return { status: 'applied' };
      }
      if (action.verb === 'Modify') {
        await updateListItem(db, action.targetId, { text: action.content ?? '' });
        return { status: 'applied' };
      }
      if (action.verb === 'Complete') {
        await updateListItem(db, action.targetId, { checked: true });
        return { status: 'applied' };
      }
      if (action.verb === 'Remove') {
        await deleteListItem(db, action.targetId);
        return { status: 'applied' };
      }
      if (action.verb === 'Clear') {
        for (const id of action.targetIds ?? [action.targetId]) {
          await deleteListItem(db, id);
        }
        return { status: 'applied' };
      }
    }

    // targetType: 'list' (whole-list Capture/Modify/Remove) is never
    // actually produced by the shipped n8n graph today (confirmed while
    // planning this task) -- fails safely rather than pretending to
    // support it.
    return { status: 'failed', reason: `unsupported targetType/verb combination: ${action.targetType}/${action.verb}` };
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
    await applyStructuredAction(db, message.small as unknown as StructuredAction);
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
