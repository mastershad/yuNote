import { openDatabase, openMigratedDatabase } from '../../src/db/connection';
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
    try {
      // Nothing else to run here -- opening it once is the whole point of
      // "first open" -- but this still needs closing failure-safe, same as
      // every other db handle in this file.
    } finally {
      firstOpen.close();
    }

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

  it('a failed migration attempt does not corrupt user_version or leave partial tables, and a subsequent successful attempt still works', async () => {
    // Drive the exact BEGIN/COMMIT/ROLLBACK primitive openMigratedDatabase
    // uses for every real migration (db.transaction) with a migration body
    // that creates one table and then fails -- without reaching into or
    // modifying the production `migrations` array in src/db/connection.ts.
    const db = await openDatabase({ name: 'test.sqlite', location: dir });

    try {
      await expect(
        db.transaction(async (tx) => {
          await tx.execute('CREATE TABLE classes (id TEXT PRIMARY KEY)');
          throw new Error('simulated partial migration failure');
        }),
      ).rejects.toThrow('simulated partial migration failure');

      // Rolled back: the table created before the throw is gone...
      const { rows: tables } = await db.execute("SELECT name FROM sqlite_master WHERE type = 'table'");
      expect(tables ?? []).toEqual([]);

      // ...and user_version was never bumped, so nothing looks "migrated".
      const { rows: versionRows } = await db.execute('SELECT * FROM pragma_user_version()');
      expect(versionRows?.[0]?.user_version).toBe(0);
    } finally {
      // Minor #6/Task 2 follow-up: the db handle must still be safely
      // closeable after a transaction it ran threw -- this would throw and
      // fail the test if the handle were left in a broken state.
      db.close();
    }

    // A subsequent, real migration attempt against the same file recovers
    // cleanly -- proving the failed attempt left no partial residue that
    // would trip "table already exists" on retry.
    const recovered = await openMigratedDatabase({ name: 'test.sqlite', location: dir });
    try {
      const { rows } = await recovered.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      );
      expect(rows?.map((r) => r.name)).toEqual(['classes', 'list_items', 'lists', 'notes']);

      const { rows: versionRows } = await recovered.execute('SELECT * FROM pragma_user_version()');
      expect(versionRows?.[0]?.user_version).toBe(1);
    } finally {
      recovered.close();
    }
  });

  it('enforces foreign keys -- inserting a list_items row referencing a nonexistent list_id throws', async () => {
    const db = await openMigratedDatabase({ name: 'test.sqlite', location: dir });

    try {
      await expect(
        db.execute(
          'INSERT INTO list_items (id, list_id, text, checked, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)',
          ['item-1', 'nonexistent-list', 'Молоко', '2026-09-07T00:00:00.000Z', '2026-09-07T00:00:00.000Z'],
        ),
      ).rejects.toThrow();
    } finally {
      db.close();
    }
  });
});
