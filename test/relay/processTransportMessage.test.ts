import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openMigratedDatabase, type OpSqliteDb } from '../../src/db/connection';
import type { LocalTransport, LocalTransportMessage } from '../../src/relay/localTransport';
import {
  processTransportMessage,
  type TransportTaskInput,
} from '../../src/relay/processTransportMessage';

describe('processTransportMessage', () => {
  let dir: string;
  let db: OpSqliteDb;
  let sent: LocalTransportMessage[];
  let transport: LocalTransport;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'yunote-transport-task-'));
    db = await openMigratedDatabase({ name: 'test.sqlite', location: dir });
    sent = [];
    transport = {
      send: async message => { sent.push(message); },
      onReceive: () => () => {},
      acknowledge: async () => {},
    };
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('applies a structured action idempotently and pushes the resulting local revision', async () => {
    const input: TransportTaskInput = {
      transferId: '11111111-1111-4111-8111-111111111111',
      kind: 'structured-action',
      payloadJson: JSON.stringify({
        verb: 'Capture',
        targetType: 'note',
        targetId: '22222222-2222-4222-8222-222222222222',
        title: 'Из Key Fob',
        content: 'Получено в фоне',
      }),
    };

    await processTransportMessage(input, { db, transport });
    await processTransportMessage(input, { db, transport });

    const rows = (await db.execute('SELECT title, content FROM notes')).rows;
    expect(rows).toEqual([{ title: 'Из Key Fob', content: 'Получено в фоне' }]);
    expect(sent.some(message => message.kind === 'sync-push')).toBe(true);
  });

  it('handles linked by marking existing data dirty and starting a sync push', async () => {
    await db.execute(
      "INSERT INTO notes (id,title,content,class_id,rev,created_at,updated_at,position) VALUES ('n1','Локальная','',NULL,1,'2026-01-01','2026-01-01',0)",
    );
    await db.execute('DELETE FROM sync_outbox');

    await processTransportMessage(
      { transferId: 'link-1', kind: 'linked', payloadJson: '{}' },
      { db, transport },
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: 'sync-push' });
  });
});
