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
  let acknowledged: string[];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'yunote-transport-task-'));
    db = await openMigratedDatabase({ name: 'test.sqlite', location: dir });
    sent = [];
    acknowledged = [];
    transport = {
      send: async message => { sent.push(message); },
      onReceive: () => () => {},
      acknowledge: async transferId => { acknowledged.push(transferId); },
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

  it('enrolls and flushes a secure linked handoff before acknowledging it', async () => {
    const order:string[]=[];
    await processTransportMessage(
      {transferId:'secure-link-1',kind:'linked',payloadJson:JSON.stringify({
        pairingToken:'a'.repeat(64),
        pairingExpiresAt:'2026-09-12T12:02:00.000Z',
        cloudBaseUrl:'https://cloud.example',
      })},
      {db,transport,installationSync:{
        enrollAndFlush:async input=>{order.push('enroll');expect(input).toEqual({
          pairingToken:'a'.repeat(64),pairingExpiresAt:'2026-09-12T12:02:00.000Z',cloudBaseUrl:'https://cloud.example',
        });},
        flushIfEnrolled:async()=>false,
        unlink:async()=>{},
      }},
    );
    order.push(...acknowledged.map(()=> 'ack'));
    expect(order).toEqual(['enroll','ack']);
    expect(acknowledged).toEqual(['secure-link-1']);
    expect(sent).toEqual([]);
  });

  it('does not acknowledge a secure linked handoff when enrollment fails', async () => {
    await expect(processTransportMessage(
      {transferId:'secure-link-fail',kind:'linked',payloadJson:JSON.stringify({
        pairingToken:'b'.repeat(64),pairingExpiresAt:'2026-09-12T12:02:00.000Z',cloudBaseUrl:'https://cloud.example',
      })},
      {db,transport,installationSync:{enrollAndFlush:async()=>{throw new Error('offline');},flushIfEnrolled:async()=>false,unlink:async()=>{}}},
    )).rejects.toThrow('offline');
    expect(acknowledged).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('uses direct upload after an enrolled structured action and does not duplicate it through Key Fob',async()=>{
    let directFlushes=0;
    await processTransportMessage({transferId:'direct-action-1',kind:'structured-action',payloadJson:JSON.stringify({
      verb:'Capture',targetType:'note',targetId:'direct-note-1',title:'Прямо',content:'В облако',
    })},{db,transport,installationSync:{enrollAndFlush:async()=>{},flushIfEnrolled:async()=>{directFlushes++;return true;},unlink:async()=>{}}});
    expect(directFlushes).toBe(1);
    expect(sent.some(message=>message.kind==='sync-push')).toBe(false);
    expect((await db.execute("SELECT title FROM notes WHERE id='direct-note-1'")).rows).toEqual([{title:'Прямо'}]);
  });

  it('keeps an applied structured action journaled when direct upload is offline',async()=>{
    await expect(processTransportMessage({transferId:'offline-action-1',kind:'structured-action',payloadJson:JSON.stringify({
      verb:'Capture',targetType:'note',targetId:'offline-note-1',title:'Локально',content:'Ждёт сеть',
    })},{db,transport,installationSync:{enrollAndFlush:async()=>{},flushIfEnrolled:async()=>{throw new Error('offline');},unlink:async()=>{}}})).rejects.toThrow('offline');
    expect((await db.execute("SELECT title FROM notes WHERE id='offline-note-1'")).rows).toEqual([{title:'Локально'}]);
    expect((await db.execute("SELECT COUNT(*) AS count FROM mutation_journal")).rows).toEqual([{count:1}]);
  });

  it('removes local installation authority before acknowledging unlink',async()=>{
    let unlinked=false;
    const guardedTransport:LocalTransport={...transport,acknowledge:async transferId=>{
      expect(unlinked).toBe(true);acknowledged.push(transferId);
    }};
    await processTransportMessage({transferId:'unlink-1',kind:'unlinked',payloadJson:'{}'},{db,transport:guardedTransport,installationSync:{
      enrollAndFlush:async()=>{},flushIfEnrolled:async()=>false,unlink:async()=>{unlinked=true;},
    }});
    expect(acknowledged).toEqual(['unlink-1']);
  });
});
