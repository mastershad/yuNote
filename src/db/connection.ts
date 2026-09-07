import { open } from '@op-engineering/op-sqlite';

export interface OpSqliteDb {
  execute(sql: string, params?: unknown[]): Promise<{ rows?: Record<string, unknown>[] }>;
  close(): void;
}

export function openDatabase(options: { name: string; location: string }): OpSqliteDb {
  return open(options);
}

interface Migration {
  version: number;
  up: (db: OpSqliteDb) => Promise<void>;
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
];

export async function openMigratedDatabase(options: { name: string; location: string }): Promise<OpSqliteDb> {
  const db = openDatabase(options);

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
      await migration.up(db);
      await db.execute(`PRAGMA user_version = ${migration.version}`);
    }
  }

  return db;
}
