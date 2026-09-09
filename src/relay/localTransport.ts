/**
 * The shared local-transport abstraction both apps (yuNote and Key Fob)
 * implement, one platform adapter each -- design spec §3.4. This repo
 * builds only the port and its in-memory test double (this plan's Task 3);
 * the real platform adapters (Android Intent-extras/FileProvider, any iOS
 * equivalent) are explicitly out of scope, deferred to a later plan.
 */
export interface LocalTransportMessage {
  transferId: string;
  kind: 'linked' | 'unlinked' | 'structured-action' | 'sync-push' | 'sync-ack' | 'sync-error';
  small?: Record<string, unknown>;
  largeRef?: { path: string; sizeBytes: number };
}

export interface LocalTransport {
  send(message: LocalTransportMessage): Promise<void>;
  // Registers a handler; returns an unsubscribe function. The handler must
  // call `acknowledge` itself once it has durably applied the message --
  // acknowledge is not automatic, so a handler that throws (or the process
  // dies mid-apply) leaves the message pending for retry.
  onReceive(handler: (message: LocalTransportMessage) => Promise<void>): () => void;
  acknowledge(transferId: string): Promise<void>;
}
