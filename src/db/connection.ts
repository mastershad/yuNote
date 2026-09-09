import { open } from '@op-engineering/op-sqlite';

// The subset of the db surface a migration body (or anything running inside
// a transaction callback) needs -- deliberately excludes `close`/`transaction`
// so a migration can't accidentally nest a transaction or close the handle
// it was handed.
export interface OpSqliteExecutor {
  execute(sql: string, params?: unknown[]): Promise<{ rows?: Record<string, unknown>[] }>;
}

export interface OpSqliteDb extends OpSqliteExecutor {
  // Wraps `fn` in a real BEGIN/COMMIT/ROLLBACK: op-sqlite's native binding and
  // its Node/Jest façade (node/dist/database.js, backed by better-sqlite3)
  // both implement this with the same contract -- if `fn` throws, everything
  // it did via `tx.execute` is rolled back and the throw propagates; if `fn`
  // resolves, the transaction commits automatically (no explicit tx.commit()
  // needed). See node_modules/@op-engineering/op-sqlite/lib/module/functions.js
  // and node_modules/@op-engineering/op-sqlite/node/dist/database.js.
  transaction(fn: (tx: OpSqliteExecutor) => Promise<void>): Promise<void>;
  close(): void;
}

export async function openDatabase(options: { name: string; location: string }): Promise<OpSqliteDb> {
  const db = open(options) as unknown as OpSqliteDb;
  // Off by default both in SQLite's own compile-time default and in the real
  // op-sqlite native build on-device; only the Node/Jest façade (better-sqlite3)
  // defaults it ON. Without this, notes.class_id -> classes(id) and
  // list_items.list_id -> lists(id) would be silently unenforced on a real
  // device while appearing enforced under every test.
  await db.execute('PRAGMA foreign_keys = ON');
  return db;
}

interface Migration {
  version: number;
  up: (db: OpSqliteExecutor) => Promise<void>;
}

// classes deliberately has no synced_at column -- this is the schema-level
// enforcement of "Classes are never transmitted to Key Fob/AI" (design spec
// §3): the sync code path this plan's later tasks build can only ever act
// on tables that have the column, so a class row structurally cannot enter
// it, rather than being filtered out of it.
const migrations: Migration[] = [
  {
    version: 1,
    up: async (db) => {
      await db.execute(`
        CREATE TABLE classes (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          created_at TEXT NOT NULL
        )
      `);
      await db.execute(`
        CREATE TABLE notes (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          class_id TEXT REFERENCES classes(id),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          synced_at TEXT
        )
      `);
      await db.execute(`
        CREATE TABLE lists (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          synced_at TEXT
        )
      `);
      await db.execute(`
        CREATE TABLE list_items (
          id TEXT PRIMARY KEY,
          list_id TEXT NOT NULL REFERENCES lists(id),
          text TEXT NOT NULL,
          checked INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          synced_at TEXT
        )
      `);
    },
  },
  {
    version: 2,
    up: async (db) => {
      // rev: bumped on every local mutation, whether user-initiated or an
      // applied Structured Action (design spec §5.1/§5.3) -- used for
      // sync idempotency/ordering, not merge conflicts (yuNote's local
      // domain layer is the single writer, so there's nothing to merge).
      // classes deliberately excluded, same rule as synced_at above: a
      // class row structurally cannot participate in sync.
      await db.execute('ALTER TABLE notes ADD COLUMN rev INTEGER NOT NULL DEFAULT 1');
      await db.execute('ALTER TABLE lists ADD COLUMN rev INTEGER NOT NULL DEFAULT 1');
      await db.execute('ALTER TABLE list_items ADD COLUMN rev INTEGER NOT NULL DEFAULT 1');

      // Dirty-row tracking for the sync outbox (design spec §5.6). `deleted`
      // is a tombstone: once a note/list/list_item is deleted locally, the
      // row itself is gone, but the outbox still needs to tell Key Fob to
      // relay a DELETE to the cloud replica -- this table is the only place
      // that fact survives the deletion.
      await db.execute(`
        CREATE TABLE sync_outbox (
          entity_type TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          deleted INTEGER NOT NULL DEFAULT 0,
          transfer_id TEXT,
          created_at TEXT NOT NULL,
          PRIMARY KEY (entity_type, entity_id)
        )
      `);
    },
  },
];

export async function openMigratedDatabase(options: { name: string; location: string }): Promise<OpSqliteDb> {
  const db = await openDatabase(options);

  // Read via the pragma_user_version() table-valued function rather than the
  // bare `PRAGMA user_version` statement form: op-sqlite's Node/Jest façade
  // (node/dist/database.js) decides whether to populate `rows` by checking
  // `query.trim().toUpperCase().startsWith("SELECT")` -- a bare PRAGMA never
  // matches that check, so `rows` always comes back empty even though the
  // pragma itself executes correctly. The table-valued function form is
  // standard SQLite (available since 3.16) and works identically against the
  // real op-sqlite native binding, so this isn't a Node-only workaround.
  const versionResult = await db.execute('SELECT * FROM pragma_user_version()');
  const currentVersion = (versionResult.rows?.[0]?.user_version as number) ?? 0;

  for (const migration of migrations) {
    if (migration.version > currentVersion) {
      // Migration DDL and the PRAGMA user_version write both participate in
      // this transaction, so a throw anywhere in `migration.up` rolls back
      // every statement it issued *and* leaves user_version untouched --
      // the file is left exactly as it was before this attempt, safe to
      // retry on next launch. Without this, a process death between the
      // tables being created and the version bump would leave tables
      // present but user_version stale, and every later open would re-run
      // `CREATE TABLE ...` and fail forever with "table already exists".
      await db.transaction(async (tx) => {
        await migration.up(tx);
        await tx.execute(`PRAGMA user_version = ${migration.version}`);
      });
    }
  }

  return db;
}
