import { openDatabase, openMigratedDatabase } from '../../src/db/connection';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const timestamp = '2026-09-10T10:00:00.000Z';

describe('local journal migration v3', () => {
  let dir:string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(),'yunote-v3-')); });
  afterEach(() => rmSync(dir,{ recursive:true, force:true }));

  async function createVersion2Database() {
    const db = await openDatabase({ name:'test.sqlite', location:dir });
    try {
      for (const sql of [
        'CREATE TABLE classes (id TEXT PRIMARY KEY,name TEXT NOT NULL,created_at TEXT NOT NULL)',
        'CREATE TABLE notes (id TEXT PRIMARY KEY,title TEXT NOT NULL,content TEXT NOT NULL,class_id TEXT REFERENCES classes(id),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,synced_at TEXT,rev INTEGER NOT NULL DEFAULT 1)',
        'CREATE TABLE lists (id TEXT PRIMARY KEY,title TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,synced_at TEXT,rev INTEGER NOT NULL DEFAULT 1)',
        'CREATE TABLE list_items (id TEXT PRIMARY KEY,list_id TEXT NOT NULL REFERENCES lists(id),text TEXT NOT NULL,checked INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,synced_at TEXT,rev INTEGER NOT NULL DEFAULT 1)',
        'CREATE TABLE sync_outbox (entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,deleted INTEGER NOT NULL DEFAULT 0,transfer_id TEXT,created_at TEXT NOT NULL,PRIMARY KEY(entity_type,entity_id))',
        'PRAGMA user_version = 2',
      ]) await db.execute(sql);
      await db.execute('INSERT INTO classes (id,name,created_at) VALUES (?,?,?)',['c','Работа',timestamp]);
      await db.execute('INSERT INTO notes (id,title,content,class_id,created_at,updated_at,rev) VALUES (?,?,?,?,?,?,?)',['n','Идея','Текст','c',timestamp,timestamp,4]);
      await db.execute('INSERT INTO lists (id,title,created_at,updated_at,rev) VALUES (?,?,?,?,?)',['l','Покупки',timestamp,timestamp,3]);
      await db.execute('INSERT INTO list_items (id,list_id,text,checked,created_at,updated_at,rev) VALUES (?,?,?,?,?,?,?)',['i','l','Хлеб',1,timestamp,timestamp,2]);
    } finally { db.close(); }
  }

  it('preserves v2 data and adds stable dataset identity, ordering, and empty journals', async () => {
    await createVersion2Database();
    let db = await openMigratedDatabase({ name:'test.sqlite', location:dir });
    let firstState:Record<string,unknown>|undefined;
    try {
      const { rows:version } = await db.execute('SELECT * FROM pragma_user_version()');
      expect(version?.[0]?.user_version).toBe(6);
      expect((await db.execute('SELECT id,name,rev,created_at,updated_at,position FROM classes')).rows).toEqual([
        { id:'c', name:'Работа', rev:1, created_at:timestamp, updated_at:timestamp, position:0 },
      ]);
      expect((await db.execute('SELECT id,title,content,class_id,rev,position FROM notes')).rows).toEqual([
        { id:'n', title:'Идея', content:'Текст', class_id:'c', rev:4, position:0 },
      ]);
      expect((await db.execute('SELECT id,title,class_id,rev,position FROM lists')).rows).toEqual([
        { id:'l', title:'Покупки', class_id:null, rev:3, position:0 },
      ]);
      expect((await db.execute('SELECT id,purpose,sharing_mode,shared_revision,collaboration_role FROM lists')).rows).toEqual([
        { id:'l', purpose:'generic', sharing_mode:'personal', shared_revision:null, collaboration_role:null },
      ]);
      expect((await db.execute('SELECT id,list_id,text,checked,rev,position FROM list_items')).rows).toEqual([
        { id:'i', list_id:'l', text:'Хлеб', checked:1, rev:2, position:0 },
      ]);
      firstState = (await db.execute('SELECT replica_id,generation,revision FROM dataset_state')).rows?.[0];
      expect(firstState).toMatchObject({ generation:1, revision:0 });
      expect(firstState?.replica_id).toMatch(/^[0-9a-f]{32}$/);
      expect((await db.execute('SELECT * FROM mutation_journal')).rows).toEqual([]);
      expect((await db.execute('SELECT * FROM applied_operations')).rows).toEqual([]);
      expect((await db.execute('SELECT * FROM installation_identity')).rows).toEqual([]);
      expect((await db.execute('SELECT * FROM collaboration_inbox_state')).rows).toEqual([{ singleton:1, acknowledged_sequence:0 }]);
    } finally { db.close(); }

    db = await openMigratedDatabase({ name:'test.sqlite', location:dir });
    try {
      expect((await db.execute('SELECT replica_id,generation,revision FROM dataset_state')).rows?.[0]).toEqual(firstState);
    } finally { db.close(); }
  });
});
