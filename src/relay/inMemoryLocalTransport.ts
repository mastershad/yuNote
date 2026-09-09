import type { LocalTransport, LocalTransportMessage } from './localTransport';

export interface InMemoryLocalTransport extends LocalTransport {
  readonly sentMessages: LocalTransportMessage[];
  readonly acknowledgedIds: string[];
  simulateReceive(message: LocalTransportMessage): Promise<void>;
}

export function createInMemoryLocalTransport(): InMemoryLocalTransport {
  const sentMessages: LocalTransportMessage[] = [];
  const acknowledgedIds: string[] = [];
  const handlers = new Set<(message: LocalTransportMessage) => Promise<void>>();

  return {
    sentMessages,
    acknowledgedIds,
    async send(message) {
      sentMessages.push(message);
    },
    onReceive(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    async acknowledge(transferId) {
      acknowledgedIds.push(transferId);
    },
    async simulateReceive(message) {
      for (const handler of handlers) {
        await handler(message);
      }
    },
  };
}
