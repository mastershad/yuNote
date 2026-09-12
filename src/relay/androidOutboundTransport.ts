import { NativeModules } from 'react-native';
import type { LocalTransport, LocalTransportMessage } from './localTransport';

interface NativeSender {
  sendMessage(uri: string, extras: {
    transferId: string;
    kind: string;
    payloadJson: string;
  }): Promise<void>;
}

export class AndroidOutboundTransport implements LocalTransport {
  private readonly nativeSender = NativeModules.YunoteTransportSender as NativeSender;

  async send(message: LocalTransportMessage): Promise<void> {
    if (!this.nativeSender?.sendMessage) {
      throw new Error('YunoteTransportSender native module is unavailable');
    }
    await this.nativeSender.sendMessage('iotkeyfobplatform://transport', {
      transferId: message.transferId,
      kind: message.kind,
      payloadJson: JSON.stringify(message.small ?? {}),
    });
  }

  onReceive(): () => void {
    return () => {};
  }

  async acknowledge(): Promise<void> {}
}

