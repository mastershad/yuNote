import { open } from '@op-engineering/op-sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('op-sqlite Node/Jest façade', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'yunote-smoke-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('opens a file database and round-trips a row', async () => {
    const db = open({ name: 'smoke.sqlite', location: dir });

    await db.execute('CREATE TABLE smoke (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
    await db.execute('INSERT INTO smoke (id, value) VALUES (?, ?)', ['1', 'hello']);
    const { rows } = await db.execute('SELECT * FROM smoke WHERE id = ?', ['1']);

    expect(rows?.length).toBe(1);
    expect(rows?.[0]).toMatchObject({ id: '1', value: 'hello' });

    db.close();
  });
});
