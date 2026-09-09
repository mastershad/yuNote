import { createInMemoryLocalTransport } from '../../src/relay/inMemoryLocalTransport';
import type { LocalTransportMessage } from '../../src/relay/localTransport';

describe('InMemoryLocalTransport', () => {
  it('records every sent message in order', async () => {
    const transport = createInMemoryLocalTransport();
    const messageA: LocalTransportMessage = { transferId: 'a', kind: 'sync-push', small: { foo: 1 } };
    const messageB: LocalTransportMessage = { transferId: 'b', kind: 'sync-push', small: { foo: 2 } };

    await transport.send(messageA);
    await transport.send(messageB);

    expect(transport.sentMessages).toEqual([messageA, messageB]);
  });

  it('delivers a simulated incoming message to every registered handler', async () => {
    const transport = createInMemoryLocalTransport();
    const received: LocalTransportMessage[] = [];
    transport.onReceive(async (message) => {
      received.push(message);
    });

    const incoming: LocalTransportMessage = { transferId: 'x', kind: 'structured-action', small: { verb: 'Capture' } };
    await transport.simulateReceive(incoming);

    expect(received).toEqual([incoming]);
  });

  it('onReceive returns an unsubscribe function that stops delivery to that handler', async () => {
    const transport = createInMemoryLocalTransport();
    const received: LocalTransportMessage[] = [];
    const unsubscribe = transport.onReceive(async (message) => {
      received.push(message);
    });

    unsubscribe();
    await transport.simulateReceive({ transferId: 'x', kind: 'linked', small: {} });

    expect(received).toEqual([]);
  });

  it('acknowledge records the transferId', async () => {
    const transport = createInMemoryLocalTransport();

    await transport.acknowledge('some-transfer-id');

    expect(transport.acknowledgedIds).toEqual(['some-transfer-id']);
  });

  it('a handler that throws does not prevent acknowledge from being callable independently, and the error propagates to the caller of simulateReceive', async () => {
    const transport = createInMemoryLocalTransport();
    transport.onReceive(async () => {
      throw new Error('handler failed');
    });

    await expect(transport.simulateReceive({ transferId: 'x', kind: 'linked', small: {} })).rejects.toThrow(
      'handler failed',
    );
  });
});
