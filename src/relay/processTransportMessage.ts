import { openMigratedDatabase, type OpSqliteDb } from '../db/connection';
import { registerActionDispatcher } from './actionDispatcher';
import type { LocalTransport, LocalTransportMessage } from './localTransport';
import { flushOutbox, registerSyncHandlers } from '../sync/outbox';
import { AndroidOutboundTransport } from './androidOutboundTransport';
import {createInstallationSync,type InstallationSync,type SecureLinkHandoff} from '../sync/installationSync';

export interface TransportTaskInput {
  transferId: string;
  kind: LocalTransportMessage['kind'];
  payloadJson?: string;
}

export interface TransportTaskDependencies {
  db: OpSqliteDb;
  transport: LocalTransport;
  installationSync?:InstallationSync;
}

function secureLinkHandoff(message:LocalTransportMessage):SecureLinkHandoff|undefined {
  if(message.kind!=='linked')return undefined;
  const value=message.small??{};
  const fields=[value.pairingToken,value.pairingExpiresAt,value.cloudBaseUrl];
  if(fields.every(field=>field===undefined))return undefined;
  if(fields.some(field=>typeof field!=='string'))throw new Error('Secure yuNote link handoff is malformed');
  return {pairingToken:value.pairingToken as string,pairingExpiresAt:value.pairingExpiresAt as string,cloudBaseUrl:value.cloudBaseUrl as string};
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
  const installationSync=dependencies?.installationSync??createInstallationSync(db);
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
    const handoff=secureLinkHandoff(message);
    if(handoff){
      await installationSync.enrollAndFlush(handoff);
      await outbound.acknowledge(message.transferId);
      return;
    }
    if(message.kind==='unlinked')await installationSync.unlink();
    for (const handler of handlers) {
      await handler(message);
    }
    if(message.kind==='structured-action'){
      const uploadedDirectly=await installationSync.flushIfEnrolled();
      if(!uploadedDirectly)await flushOutbox(db,outbound);
    }else if(message.kind==='linked'){
      await flushOutbox(db, outbound);
    }
  } finally {
    unregisterAction();
    unregisterSync();
    ownedDb?.close();
  }
}

