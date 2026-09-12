import { openMigratedDatabase, type OpSqliteDb } from '../db/connection';
import { registerActionDispatcher } from './actionDispatcher';
import type { LocalTransport, LocalTransportMessage } from './localTransport';
import { flushOutbox, registerSyncHandlers } from '../sync/outbox';
import { AndroidOutboundTransport } from './androidOutboundTransport';

export interface TransportTaskInput {
  transferId: string;
  kind: LocalTransportMessage['kind'];
  payloadJson?: string;
}

export interface TransportTaskDependencies {
  db: OpSqliteDb;
  transport: LocalTransport;
}

function decodeMessage(input: TransportTaskInput): LocalTransportMessage {
  if (!input.transferId || !input.kind) {
    throw new Error('Transport message is missing transferId or kind');
  }
  let small: Record<string, unknown> | undefined;
  if (input.payloadJson) {
    const parsed: unknown = JSON.parse(input.payloadJson);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('Transport payload must be a JSON object');
    }
    small = parsed as Record<string, unknown>;
  }
  return { transferId: input.transferId, kind: input.kind, small };
}

export async function processTransportMessage(
  input: TransportTaskInput,
  dependencies?: TransportTaskDependencies,
): Promise<void> {
  const ownedDb = dependencies ? null : await openMigratedDatabase({ name: 'yunote.sqlite', location: 'default' });
  const db = dependencies?.db ?? ownedDb!;
  const outbound = dependencies?.transport ?? new AndroidOutboundTransport();
  const handlers = new Set<(message: LocalTransportMessage) => Promise<void>>();
  const dispatchTransport: LocalTransport = {
    send: message => outbound.send(message),
    onReceive(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    acknowledge: transferId => outbound.acknowledge(transferId),
  };

  const unregisterAction = registerActionDispatcher(db, dispatchTransport);
  const unregisterSync = registerSyncHandlers(db, dispatchTransport);
  const message = decodeMessage(input);

  try {
    for (const handler of handlers) {
      await handler(message);
    }
    if (message.kind === 'structured-action' || message.kind === 'linked') {
      await flushOutbox(db, outbound);
    }
  } finally {
    unregisterAction();
    unregisterSync();
    ownedDb?.close();
  }
}

