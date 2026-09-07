import { openMigratedDatabase } from '../../src/db/connection';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('openMigratedDatabase', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'yunote-migration-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates all four tables on a fresh database', async () => {
    const db = await openMigratedDatabase({ name: 'test.sqlite', location: dir });

    try {
      const { rows } = await db.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      );

      expect(rows?.map((r) => r.name)).toEqual(['classes', 'list_items', 'lists', 'notes']);
    } finally {
      db.close();
    }
  });

  it('sets user_version to the latest migration after running', async () => {
    const db = await openMigratedDatabase({ name: 'test.sqlite', location: dir });

    try {
      // Bare `PRAGMA user_version` never populates `rows` through op-sqlite's
      // Node/Jest façade (its executeSync only treats queries that literally
      // start with "SELECT" as row-returning) -- the table-valued function
      // form is standard SQLite and works against both the façade and the
      // real native binding. See src/db/connection.ts for the full note.
      const { rows } = await db.execute('SELECT * FROM pragma_user_version()');

      expect(rows?.[0]?.user_version).toBe(1);
    } finally {
      db.close();
    }
  });

  it('is idempotent -- opening an already-migrated database does not error or duplicate tables', async () => {
    const firstOpen = await openMigratedDatabase({ name: 'test.sqlite', location: dir });
    firstOpen.close();

    const secondOpen = await openMigratedDatabase({ name: 'test.sqlite', location: dir });

    try {
      const { rows } = await secondOpen.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      );

      expect(rows?.map((r) => r.name)).toEqual(['classes', 'list_items', 'lists', 'notes']);
    } finally {
      secondOpen.close();
    }
  });

  it('classes table has no synced_at column', async () => {
    const db = await openMigratedDatabase({ name: 'test.sqlite', location: dir });

    try {
      // See the user_version test above: bare PRAGMA statements never
      // populate `rows` through the Node/Jest façade, so use the
      // table-valued pragma_table_info() form instead.
      const { rows } = await db.execute("SELECT * FROM pragma_table_info('classes')");

      expect(rows?.some((r) => r.name === 'synced_at')).toBe(false);
    } finally {
      db.close();
    }
  });

  it('notes, lists, and list_items each have a synced_at column', async () => {
    const db = await openMigratedDatabase({ name: 'test.sqlite', location: dir });

    try {
      for (const table of ['notes', 'lists', 'list_items']) {
        const { rows } = await db.execute(`SELECT * FROM pragma_table_info('${table}')`);
        expect(rows?.some((r) => r.name === 'synced_at')).toBe(true);
      }
    } finally {
      db.close();
    }
  });
});
