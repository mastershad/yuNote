# yuNote Local Data Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build yuNote's local offline-first data layer — SQLite schema, migrations, a repository layer, and the Zustand stores that back the UI — with zero dependency on Key Fob, pairing, or any network access.

**Architecture:** Bare React Native (matching `IoT-Key-Fob-Project/mobile-app`'s proven RN 0.86/React 19/TypeScript 5.8 toolchain) using `@op-engineering/op-sqlite` for storage. This plan is scoped to the data layer only — no screens, no gestures, no native `android/`/`ios/` project scaffolding, since nothing here needs to launch on a device or simulator; every task is verified through Jest using op-sqlite's documented Node.js testing façade (same API as the real RN binding, intended by its authors specifically for this purpose). Native scaffolding and the gesture-driven UI from the spec's §5 are a separate, later plan once visual/UX design exists for them.

**Tech Stack:** TypeScript, `@op-engineering/op-sqlite` 18.2.0, Zustand (matching `mobile-app`'s already-used `^5.0.14`), Jest via `@react-native/jest-preset` 0.86.0, `uuid` + `react-native-get-random-values` for client-generated IDs.

**Spec:** `docs/superpowers/specs/2026-09-07-yunote-local-app-design.md`

## Global Constraints

- IDs are UUIDs, generated client-side (spec §3) — never server-assigned, never auto-increment.
- Timestamps are ISO 8601 strings in `TEXT` columns (spec §3), matching this ecosystem's existing convention.
- `classes` never gets a `synced_at` column and no code path in this plan ever sends a class row anywhere — this is the schema-level enforcement of "Classes are never transmitted to Key Fob/AI" (spec §3).
- `synced_at IS NULL OR updated_at > synced_at` is the entire sync-dirty-tracking mechanism (spec §3) — no outbox table.
- Every repository function is `async` — `op-sqlite`'s `execute()` is Promise-based.
- No screens, no gesture code, no `android/`/`ios/` folders in this plan (spec §8 / this plan's own scope note above).

---

## Task 1: Project bootstrap + verify op-sqlite's Node/Jest façade

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `babel.config.js`
- Create: `jest.config.js`
- Create: `src/db/connection.ts`
- Test: `test/db/connection.smoke.test.ts`

**Interfaces:**
- Produces: `openDatabase(options: { name: string; location: string }): OpSqliteDb` (the raw `@op-engineering/op-sqlite` handle, untyped beyond what the library exports) — Task 2 wraps this with migrations; nothing else in this task is a public interface yet.

This task's real purpose is de-risking `op-sqlite`'s documented-but-unverified-in-this-project Node.js testing façade before any schema/repository code is built on top of an assumption. `op-sqlite`'s own docs state it ships "a NodeJS compatible façade with the same API as the RN version... to enable you to write simple Jest tests that test your queries" — this step proves that claim against this exact toolchain.

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "yuNote",
  "version": "0.0.1",
  "private": true,
  "scripts": {
    "test": "jest"
  },
  "dependencies": {
    "@op-engineering/op-sqlite": "^18.2.0",
    "react": "19.2.3",
    "react-native": "0.86.0",
    "react-native-get-random-values": "^1.11.0",
    "uuid": "^11.0.5",
    "zustand": "^5.0.14"
  },
  "devDependencies": {
    "@babel/core": "^7.25.2",
    "@babel/preset-env": "^7.25.3",
    "@babel/runtime": "^7.25.0",
    "@react-native/babel-preset": "0.86.0",
    "@react-native/jest-preset": "0.86.0",
    "@react-native/typescript-config": "0.86.0",
    "@types/jest": "^29.5.13",
    "@types/uuid": "^10.0.0",
    "jest": "^29.6.3",
    "typescript": "^5.8.3"
  },
  "engines": {
    "node": ">= 22.11.0"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "extends": "@react-native/typescript-config",
  "compilerOptions": {
    "types": ["jest"]
  },
  "include": ["src/**/*.ts", "test/**/*.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 3: Write `babel.config.js`**

```js
module.exports = {
  presets: ['module:@react-native/babel-preset'],
};
```

- [ ] **Step 4: Write `jest.config.js`**

```js
module.exports = {
  preset: '@react-native/jest-preset',
  transformIgnorePatterns: [
    'node_modules/(?!(react-native|@react-native|@op-engineering/op-sqlite)/)',
  ],
};
```

- [ ] **Step 5: Install dependencies**

Run: `npm install`
Expected: completes without error (peer dependency warnings for `@sqlite.org/sqlite-wasm` are expected and fine — that peer is only relevant for op-sqlite's web target, which this project doesn't use).

- [ ] **Step 6: Write the failing smoke test**

Create `test/db/connection.smoke.test.ts`:

```ts
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
  });
});
```

- [ ] **Step 7: Run the test**

Run: `npx jest test/db/connection.smoke.test.ts`
Expected: PASS. If it fails with a module-resolution error, that means `op-sqlite`'s Node façade doesn't auto-resolve under this exact jest preset — STOP and report back rather than guessing at a fix; this is exactly the risk this task exists to surface early. If it fails on the `location`/`open` call shape itself, check the installed version's actual exported types (`node_modules/@op-engineering/op-sqlite/lib/typescript/index.d.ts`) against what this step assumed, and report the discrepancy rather than silently reshaping every later task around a guess.

- [ ] **Step 8: Write `src/db/connection.ts`'s first slice**

```ts
import { open } from '@op-engineering/op-sqlite';

export interface OpSqliteDb {
  execute(sql: string, params?: unknown[]): Promise<{ rows?: Record<string, unknown>[] }>;
}

export function openDatabase(options: { name: string; location: string }): OpSqliteDb {
  return open(options);
}
```

- [ ] **Step 9: Commit**

```bash
git add package.json tsconfig.json babel.config.js jest.config.js src/db/connection.ts test/db/connection.smoke.test.ts
git commit -m "chore: bootstrap project and verify op-sqlite's Jest façade"
```

---

## Task 2: Migrations + schema v1

**Files:**
- Modify: `src/db/connection.ts`
- Test: `test/db/connection.test.ts`

**Interfaces:**
- Consumes: `openDatabase` (Task 1).
- Produces: `openMigratedDatabase(options: { name: string; location: string }): Promise<OpSqliteDb>` — every later task's repository functions and tests open their database through this, never through raw `openDatabase`, so schema is always current.

- [ ] **Step 1: Write the failing tests**

Create `test/db/connection.test.ts`:

```ts
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

    const { rows } = await db.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    );

    expect(rows?.map((r) => r.name)).toEqual(['classes', 'list_items', 'lists', 'notes']);
  });

  it('sets user_version to the latest migration after running', async () => {
    const db = await openMigratedDatabase({ name: 'test.sqlite', location: dir });

    const { rows } = await db.execute('PRAGMA user_version');

    expect(rows?.[0]?.user_version).toBe(1);
  });

  it('is idempotent -- opening an already-migrated database does not error or duplicate tables', async () => {
    await openMigratedDatabase({ name: 'test.sqlite', location: dir });
    const secondOpen = await openMigratedDatabase({ name: 'test.sqlite', location: dir });

    const { rows } = await secondOpen.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    );

    expect(rows?.map((r) => r.name)).toEqual(['classes', 'list_items', 'lists', 'notes']);
  });

  it('classes table has no synced_at column', async () => {
    const db = await openMigratedDatabase({ name: 'test.sqlite', location: dir });

    const { rows } = await db.execute('PRAGMA table_info(classes)');

    expect(rows?.some((r) => r.name === 'synced_at')).toBe(false);
  });

  it('notes, lists, and list_items each have a synced_at column', async () => {
    const db = await openMigratedDatabase({ name: 'test.sqlite', location: dir });

    for (const table of ['notes', 'lists', 'list_items']) {
      const { rows } = await db.execute(`PRAGMA table_info(${table})`);
      expect(rows?.some((r) => r.name === 'synced_at')).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest test/db/connection.test.ts`
Expected: FAIL — `openMigratedDatabase` doesn't exist yet.

- [ ] **Step 3: Implement migrations in `src/db/connection.ts`**

Replace the file's full contents with:

```ts
import { open } from '@op-engineering/op-sqlite';

export interface OpSqliteDb {
  execute(sql: string, params?: unknown[]): Promise<{ rows?: Record<string, unknown>[] }>;
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

  const versionResult = await db.execute('PRAGMA user_version');
  const currentVersion = (versionResult.rows?.[0]?.user_version as number) ?? 0;

  for (const migration of migrations) {
    if (migration.version > currentVersion) {
      await migration.up(db);
      await db.execute(`PRAGMA user_version = ${migration.version}`);
    }
  }

  return db;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest test/db/connection.test.ts`
Expected: PASS (5/5)

- [ ] **Step 5: Commit**

```bash
git add src/db/connection.ts test/db/connection.test.ts
git commit -m "feat: add PRAGMA user_version migration runner and v1 schema"
```

---

## Task 3: `id` and `now` shared utilities

**Files:**
- Create: `src/data/id.ts`
- Test: `test/data/id.test.ts`

**Interfaces:**
- Produces: `generateId(): string`, `nowIso(): string` — every repository function in Tasks 4-6 uses both.

- [ ] **Step 1: Write the failing test**

Create `test/data/id.test.ts`:

```ts
import { generateId, nowIso } from '../../src/data/id';

describe('generateId', () => {
  it('returns a valid UUID v4', () => {
    const id = generateId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it('returns a different id on each call', () => {
    expect(generateId()).not.toBe(generateId());
  });
});

describe('nowIso', () => {
  it('returns a valid ISO 8601 timestamp', () => {
    expect(new Date(nowIso()).toISOString()).toBe(nowIso());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/data/id.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Write the implementation**

Create `src/data/id.ts`:

```ts
import 'react-native-get-random-values';
import { v4 as uuidv4 } from 'uuid';

export function generateId(): string {
  return uuidv4();
}

export function nowIso(): string {
  return new Date().toISOString();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest test/data/id.test.ts`
Expected: PASS (3/3)

- [ ] **Step 5: Commit**

```bash
git add src/data/id.ts test/data/id.test.ts
git commit -m "feat: add generateId/nowIso shared utilities"
```

---

## Task 4: Classes repository

**Files:**
- Create: `src/data/classes.ts`
- Test: `test/data/classes.test.ts`

**Interfaces:**
- Consumes: `openMigratedDatabase` (Task 2), `generateId`/`nowIso` (Task 3).
- Produces: `Class { id: string; name: string; createdAt: string }`, `createClass(db, name: string): Promise<Class>`, `deleteClass(db, id: string): Promise<void>`, `listClasses(db): Promise<Class[]>`. Task 5's note repository consumes `Class['id']` as the type of `classId`; Task 6's classes store consumes all three functions.

`deleteClass` must null out `class_id` on every note that referenced it (design spec §9 / the original product requirement: "Удаление класса не должно удалять содержащиеся в нём заметки") — this is the one piece of cross-table logic in this repository.

- [ ] **Step 1: Write the failing tests**

Create `test/data/classes.test.ts`:

```ts
import { openMigratedDatabase, type OpSqliteDb } from '../../src/db/connection';
import { createClass, deleteClass, listClasses } from '../../src/data/classes';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('classes repository', () => {
  let dir: string;
  let db: OpSqliteDb;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'yunote-classes-test-'));
    db = await openMigratedDatabase({ name: 'test.sqlite', location: dir });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates a class and lists it back', async () => {
    const created = await createClass(db, 'Работа');

    expect(created.name).toBe('Работа');
    expect(typeof created.id).toBe('string');

    const all = await listClasses(db);
    expect(all).toEqual([created]);
  });

  it('can exist with zero notes referencing it', async () => {
    await createClass(db, 'Пустой класс');

    const all = await listClasses(db);
    expect(all.length).toBe(1);
  });

  it('deleteClass removes the class but does not delete its notes -- their class_id becomes NULL', async () => {
    const cls = await createClass(db, 'Работа');
    await db.execute(
      'INSERT INTO notes (id, title, content, class_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['note-1', 'Идея', 'текст', cls.id, '2026-09-07T00:00:00.000Z', '2026-09-07T00:00:00.000Z'],
    );

    await deleteClass(db, cls.id);

    const remainingClasses = await listClasses(db);
    expect(remainingClasses).toEqual([]);

    const { rows } = await db.execute('SELECT * FROM notes WHERE id = ?', ['note-1']);
    expect(rows?.length).toBe(1);
    expect(rows?.[0]?.class_id).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest test/data/classes.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Write the implementation**

Create `src/data/classes.ts`:

```ts
import type { OpSqliteDb } from '../db/connection';
import { generateId, nowIso } from './id';

export interface Class {
  id: string;
  name: string;
  createdAt: string;
}

interface ClassRow {
  id: string;
  name: string;
  created_at: string;
}

function toClass(row: ClassRow): Class {
  return { id: row.id, name: row.name, createdAt: row.created_at };
}

export async function createClass(db: OpSqliteDb, name: string): Promise<Class> {
  const id = generateId();
  const createdAt = nowIso();
  await db.execute('INSERT INTO classes (id, name, created_at) VALUES (?, ?, ?)', [id, name, createdAt]);
  return { id, name, createdAt };
}

export async function deleteClass(db: OpSqliteDb, id: string): Promise<void> {
  // Order matters: null out referencing notes before deleting the class row,
  // so a note is never left pointing at a class_id that no longer exists.
  await db.execute('UPDATE notes SET class_id = NULL WHERE class_id = ?', [id]);
  await db.execute('DELETE FROM classes WHERE id = ?', [id]);
}

export async function listClasses(db: OpSqliteDb): Promise<Class[]> {
  const { rows } = await db.execute('SELECT * FROM classes ORDER BY name');
  return ((rows ?? []) as unknown as ClassRow[]).map(toClass);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest test/data/classes.test.ts`
Expected: PASS (3/3)

- [ ] **Step 5: Commit**

```bash
git add src/data/classes.ts test/data/classes.test.ts
git commit -m "feat: add classes repository"
```

---

## Task 5: Notes repository

**Files:**
- Create: `src/data/notes.ts`
- Test: `test/data/notes.test.ts`

**Interfaces:**
- Consumes: `openMigratedDatabase` (Task 2), `generateId`/`nowIso` (Task 3), `Class['id']` shape (Task 4, for `classId` typing only — no direct call into `classes.ts`).
- Produces: `Note { id: string; title: string; content: string; classId: string | null; createdAt: string; updatedAt: string }`, `createNote(db, input: { title: string; content: string; classId?: string }): Promise<Note>`, `updateNote(db, id: string, patch: Partial<{ title: string; content: string; classId: string | null }>): Promise<Note>`, `deleteNote(db, id: string): Promise<void>`, `listNotes(db, options: { classId?: string | null; sort: 'date-desc' | 'date-asc' | 'title-asc' | 'title-desc' }): Promise<Note[]>`. Task 7's notes store consumes all four.

- [ ] **Step 1: Write the failing tests**

Create `test/data/notes.test.ts`:

```ts
import { openMigratedDatabase, type OpSqliteDb } from '../../src/db/connection';
import { createNote, updateNote, deleteNote, listNotes } from '../../src/data/notes';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('notes repository', () => {
  let dir: string;
  let db: OpSqliteDb;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'yunote-notes-test-'));
    db = await openMigratedDatabase({ name: 'test.sqlite', location: dir });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates a note with no class by default', async () => {
    const note = await createNote(db, { title: 'Идея', content: 'текст' });

    expect(note.title).toBe('Идея');
    expect(note.classId).toBeNull();
    expect(note.createdAt).toBe(note.updatedAt);
  });

  it('creates a note with an explicit classId', async () => {
    const note = await createNote(db, { title: 'Идея', content: 'текст', classId: 'class-1' });
    expect(note.classId).toBe('class-1');
  });

  it('updateNote patches only the given fields, leaving the rest unchanged', async () => {
    const note = await createNote(db, { title: 'Старое', content: 'старый текст' });

    const updated = await updateNote(db, note.id, { title: 'Новое' });

    expect(updated.title).toBe('Новое');
    expect(updated.content).toBe('старый текст');
    expect(updated.id).toBe(note.id);
    expect(updated.createdAt).toBe(note.createdAt);
  });

  it('updateNote can set classId back to null (unclassify)', async () => {
    const note = await createNote(db, { title: 'Идея', content: 'текст', classId: 'class-1' });

    const updated = await updateNote(db, note.id, { classId: null });

    expect(updated.classId).toBeNull();
  });

  it('deleteNote removes the row', async () => {
    const note = await createNote(db, { title: 'Идея', content: 'текст' });

    await deleteNote(db, note.id);

    const all = await listNotes(db, { sort: 'date-desc' });
    expect(all).toEqual([]);
  });

  it('listNotes filters by classId', async () => {
    await createNote(db, { title: 'A', content: '', classId: 'class-1' });
    await createNote(db, { title: 'B', content: '' });

    const classified = await listNotes(db, { classId: 'class-1', sort: 'date-desc' });
    expect(classified.map((n) => n.title)).toEqual(['A']);

    const unclassified = await listNotes(db, { classId: null, sort: 'date-desc' });
    expect(unclassified.map((n) => n.title)).toEqual(['B']);
  });

  it('listNotes sorts by title ascending and descending', async () => {
    await createNote(db, { title: 'Банан', content: '' });
    await createNote(db, { title: 'Апельсин', content: '' });

    const asc = await listNotes(db, { sort: 'title-asc' });
    expect(asc.map((n) => n.title)).toEqual(['Апельсин', 'Банан']);

    const desc = await listNotes(db, { sort: 'title-desc' });
    expect(desc.map((n) => n.title)).toEqual(['Банан', 'Апельсин']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest test/data/notes.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Write the implementation**

Create `src/data/notes.ts`:

```ts
import type { OpSqliteDb } from '../db/connection';
import { generateId, nowIso } from './id';

export interface Note {
  id: string;
  title: string;
  content: string;
  classId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface NoteRow {
  id: string;
  title: string;
  content: string;
  class_id: string | null;
  created_at: string;
  updated_at: string;
}

function toNote(row: NoteRow): Note {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    classId: row.class_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createNote(
  db: OpSqliteDb,
  input: { title: string; content: string; classId?: string },
): Promise<Note> {
  const id = generateId();
  const timestamp = nowIso();
  const classId = input.classId ?? null;
  await db.execute(
    'INSERT INTO notes (id, title, content, class_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    [id, input.title, input.content, classId, timestamp, timestamp],
  );
  return { id, title: input.title, content: input.content, classId, createdAt: timestamp, updatedAt: timestamp };
}

export async function updateNote(
  db: OpSqliteDb,
  id: string,
  patch: Partial<{ title: string; content: string; classId: string | null }>,
): Promise<Note> {
  const { rows } = await db.execute('SELECT * FROM notes WHERE id = ?', [id]);
  const existing = toNote((rows as unknown as NoteRow[])[0]);

  const next: Note = {
    ...existing,
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.content !== undefined ? { content: patch.content } : {}),
    ...(patch.classId !== undefined ? { classId: patch.classId } : {}),
    updatedAt: nowIso(),
  };

  await db.execute(
    'UPDATE notes SET title = ?, content = ?, class_id = ?, updated_at = ? WHERE id = ?',
    [next.title, next.content, next.classId, next.updatedAt, id],
  );

  return next;
}

export async function deleteNote(db: OpSqliteDb, id: string): Promise<void> {
  await db.execute('DELETE FROM notes WHERE id = ?', [id]);
}

export async function listNotes(
  db: OpSqliteDb,
  options: { classId?: string | null; sort: 'date-desc' | 'date-asc' | 'title-asc' | 'title-desc' },
): Promise<Note[]> {
  const orderBy = {
    'date-desc': 'updated_at DESC',
    'date-asc': 'updated_at ASC',
    'title-asc': 'title ASC',
    'title-desc': 'title DESC',
  }[options.sort];

  if (options.classId === undefined) {
    const { rows } = await db.execute(`SELECT * FROM notes ORDER BY ${orderBy}`);
    return ((rows ?? []) as unknown as NoteRow[]).map(toNote);
  }

  if (options.classId === null) {
    const { rows } = await db.execute(`SELECT * FROM notes WHERE class_id IS NULL ORDER BY ${orderBy}`);
    return ((rows ?? []) as unknown as NoteRow[]).map(toNote);
  }

  const { rows } = await db.execute(`SELECT * FROM notes WHERE class_id = ? ORDER BY ${orderBy}`, [options.classId]);
  return ((rows ?? []) as unknown as NoteRow[]).map(toNote);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest test/data/notes.test.ts`
Expected: PASS (7/7)

- [ ] **Step 5: Commit**

```bash
git add src/data/notes.ts test/data/notes.test.ts
git commit -m "feat: add notes repository"
```

---

## Task 6: Lists + list items repository

**Files:**
- Create: `src/data/lists.ts`
- Test: `test/data/lists.test.ts`

**Interfaces:**
- Consumes: `openMigratedDatabase` (Task 2), `generateId`/`nowIso` (Task 3).
- Produces: `List { id: string; title: string; createdAt: string; updatedAt: string }`, `ListItem { id: string; listId: string; text: string; checked: boolean; createdAt: string; updatedAt: string }`, `createList(db, title: string): Promise<List>`, `deleteList(db, id: string): Promise<void>`, `listLists(db): Promise<List[]>`, `addListItem(db, listId: string, text: string): Promise<ListItem>`, `updateListItem(db, id: string, patch: Partial<{ text: string; checked: boolean }>): Promise<ListItem>`, `deleteListItem(db, id: string): Promise<void>`, `listItemsForList(db, listId: string): Promise<ListItem[]>`. Task 7's lists store consumes all seven.

`deleteList` cascades to its items (unlike `deleteClass`, which explicitly must NOT cascade to notes) — a list without its items is meaningless, whereas a class is just a label notes can lose without losing the notes themselves.

- [ ] **Step 1: Write the failing tests**

Create `test/data/lists.test.ts`:

```ts
import { openMigratedDatabase, type OpSqliteDb } from '../../src/db/connection';
import {
  createList,
  deleteList,
  listLists,
  addListItem,
  updateListItem,
  deleteListItem,
  listItemsForList,
} from '../../src/data/lists';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('lists repository', () => {
  let dir: string;
  let db: OpSqliteDb;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'yunote-lists-test-'));
    db = await openMigratedDatabase({ name: 'test.sqlite', location: dir });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates and lists a list', async () => {
    const list = await createList(db, 'Покупки');
    expect(await listLists(db)).toEqual([list]);
  });

  it('adds items to a list, unchecked by default', async () => {
    const list = await createList(db, 'Покупки');
    const item = await addListItem(db, list.id, 'Молоко');

    expect(item.text).toBe('Молоко');
    expect(item.checked).toBe(false);
    expect(item.listId).toBe(list.id);
  });

  it('updateListItem can toggle checked and edit text independently', async () => {
    const list = await createList(db, 'Покупки');
    const item = await addListItem(db, list.id, 'Молоко');

    const checked = await updateListItem(db, item.id, { checked: true });
    expect(checked.checked).toBe(true);
    expect(checked.text).toBe('Молоко');

    const renamed = await updateListItem(db, item.id, { text: 'Овсяное молоко' });
    expect(renamed.text).toBe('Овсяное молоко');
    expect(renamed.checked).toBe(true);
  });

  it('deleteListItem removes only that item', async () => {
    const list = await createList(db, 'Покупки');
    const keep = await addListItem(db, list.id, 'Молоко');
    const remove = await addListItem(db, list.id, 'Хлеб');

    await deleteListItem(db, remove.id);

    const remaining = await listItemsForList(db, list.id);
    expect(remaining.map((i) => i.id)).toEqual([keep.id]);
  });

  it('deleteList cascades to its items', async () => {
    const list = await createList(db, 'Покупки');
    await addListItem(db, list.id, 'Молоко');

    await deleteList(db, list.id);

    expect(await listLists(db)).toEqual([]);
    expect(await listItemsForList(db, list.id)).toEqual([]);
  });

  it('listItemsForList only returns items for that list', async () => {
    const listA = await createList(db, 'Покупки');
    const listB = await createList(db, 'Дела');
    await addListItem(db, listA.id, 'Молоко');
    await addListItem(db, listB.id, 'Позвонить маме');

    const itemsA = await listItemsForList(db, listA.id);
    expect(itemsA.map((i) => i.text)).toEqual(['Молоко']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest test/data/lists.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Write the implementation**

Create `src/data/lists.ts`:

```ts
import type { OpSqliteDb } from '../db/connection';
import { generateId, nowIso } from './id';

export interface List {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface ListItem {
  id: string;
  listId: string;
  text: string;
  checked: boolean;
  createdAt: string;
  updatedAt: string;
}

interface ListRow {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

interface ListItemRow {
  id: string;
  list_id: string;
  text: string;
  checked: number;
  created_at: string;
  updated_at: string;
}

function toList(row: ListRow): List {
  return { id: row.id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at };
}

function toListItem(row: ListItemRow): ListItem {
  return {
    id: row.id,
    listId: row.list_id,
    text: row.text,
    checked: row.checked === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createList(db: OpSqliteDb, title: string): Promise<List> {
  const id = generateId();
  const timestamp = nowIso();
  await db.execute('INSERT INTO lists (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)', [
    id,
    title,
    timestamp,
    timestamp,
  ]);
  return { id, title, createdAt: timestamp, updatedAt: timestamp };
}

export async function deleteList(db: OpSqliteDb, id: string): Promise<void> {
  // Cascades to items, deliberately unlike deleteClass -- a list's items
  // aren't meaningful without the list, whereas a class is just a label.
  await db.execute('DELETE FROM list_items WHERE list_id = ?', [id]);
  await db.execute('DELETE FROM lists WHERE id = ?', [id]);
}

export async function listLists(db: OpSqliteDb): Promise<List[]> {
  const { rows } = await db.execute('SELECT * FROM lists ORDER BY updated_at DESC');
  return ((rows ?? []) as unknown as ListRow[]).map(toList);
}

export async function addListItem(db: OpSqliteDb, listId: string, text: string): Promise<ListItem> {
  const id = generateId();
  const timestamp = nowIso();
  await db.execute(
    'INSERT INTO list_items (id, list_id, text, checked, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)',
    [id, listId, text, timestamp, timestamp],
  );
  return { id, listId, text, checked: false, createdAt: timestamp, updatedAt: timestamp };
}

export async function updateListItem(
  db: OpSqliteDb,
  id: string,
  patch: Partial<{ text: string; checked: boolean }>,
): Promise<ListItem> {
  const { rows } = await db.execute('SELECT * FROM list_items WHERE id = ?', [id]);
  const existing = toListItem((rows as unknown as ListItemRow[])[0]);

  const next: ListItem = {
    ...existing,
    ...(patch.text !== undefined ? { text: patch.text } : {}),
    ...(patch.checked !== undefined ? { checked: patch.checked } : {}),
    updatedAt: nowIso(),
  };

  await db.execute('UPDATE list_items SET text = ?, checked = ?, updated_at = ? WHERE id = ?', [
    next.text,
    next.checked ? 1 : 0,
    next.updatedAt,
    id,
  ]);

  return next;
}

export async function deleteListItem(db: OpSqliteDb, id: string): Promise<void> {
  await db.execute('DELETE FROM list_items WHERE id = ?', [id]);
}

export async function listItemsForList(db: OpSqliteDb, listId: string): Promise<ListItem[]> {
  const { rows } = await db.execute('SELECT * FROM list_items WHERE list_id = ? ORDER BY created_at ASC', [listId]);
  return ((rows ?? []) as unknown as ListItemRow[]).map(toListItem);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest test/data/lists.test.ts`
Expected: PASS (6/6)

- [ ] **Step 5: Commit**

```bash
git add src/data/lists.ts test/data/lists.test.ts
git commit -m "feat: add lists and list_items repository"
```

---

## Task 7: Zustand stores

**Files:**
- Create: `src/state/notesStore.ts`
- Create: `src/state/listsStore.ts`
- Create: `src/state/classesStore.ts`
- Test: `test/state/notesStore.test.ts`
- Test: `test/state/listsStore.test.ts`
- Test: `test/state/classesStore.test.ts`

**Interfaces:**
- Consumes: every repository function from Tasks 4-6, `OpSqliteDb` from Task 2.
- Produces: `createNotesStore(db)`, `createListsStore(db)`, `createClassesStore(db)` — factory functions returning a Zustand store bound to a specific `OpSqliteDb` instance (dependency injection, not a global singleton — required for the tests in this task, and for a future UI plan to construct real hooks like `export const useNotesStore = createNotesStore(appDb)` once an app-wide `db` instance exists). Each store's shape is documented in its own section below.

Per design spec §4: every store action does exactly two things in order — write to SQLite via the repository layer, then update the store's in-memory slice — so screens never read SQLite directly.

- [ ] **Step 1: Write the failing test for the notes store**

Create `test/state/notesStore.test.ts`:

```ts
import { openMigratedDatabase, type OpSqliteDb } from '../../src/db/connection';
import { createNotesStore } from '../../src/state/notesStore';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('notes store', () => {
  let dir: string;
  let db: OpSqliteDb;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'yunote-notes-store-test-'));
    db = await openMigratedDatabase({ name: 'test.sqlite', location: dir });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('loadNotes populates the notes slice from the database', async () => {
    const store = createNotesStore(db);
    await store.getState().createNote({ title: 'Идея', content: 'текст' });

    await store.getState().loadNotes({ sort: 'date-desc' });

    expect(store.getState().notes.map((n) => n.title)).toEqual(['Идея']);
  });

  it('createNote writes to the database and updates the slice without a separate reload', async () => {
    const store = createNotesStore(db);

    await store.getState().createNote({ title: 'Идея', content: 'текст' });

    expect(store.getState().notes.length).toBe(1);
  });

  it('deleteNote removes it from both the database and the slice', async () => {
    const store = createNotesStore(db);
    const note = await store.getState().createNote({ title: 'Идея', content: 'текст' });

    await store.getState().deleteNote(note.id);

    expect(store.getState().notes).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/state/notesStore.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Write `src/state/notesStore.ts`**

```ts
import { create, type StoreApi, type UseBoundStore } from 'zustand';
import type { OpSqliteDb } from '../db/connection';
import { createNote as repoCreateNote, updateNote as repoUpdateNote, deleteNote as repoDeleteNote, listNotes, type Note } from '../data/notes';

interface NotesState {
  notes: Note[];
  loadNotes(options: { classId?: string | null; sort: 'date-desc' | 'date-asc' | 'title-asc' | 'title-desc' }): Promise<void>;
  createNote(input: { title: string; content: string; classId?: string }): Promise<Note>;
  updateNote(id: string, patch: Partial<{ title: string; content: string; classId: string | null }>): Promise<Note>;
  deleteNote(id: string): Promise<void>;
}

export function createNotesStore(db: OpSqliteDb): UseBoundStore<StoreApi<NotesState>> {
  return create<NotesState>((set, get) => ({
    notes: [],
    async loadNotes(options) {
      const notes = await listNotes(db, options);
      set({ notes });
    },
    async createNote(input) {
      const note = await repoCreateNote(db, input);
      set({ notes: [note, ...get().notes] });
      return note;
    },
    async updateNote(id, patch) {
      const updated = await repoUpdateNote(db, id, patch);
      set({ notes: get().notes.map((n) => (n.id === id ? updated : n)) });
      return updated;
    },
    async deleteNote(id) {
      await repoDeleteNote(db, id);
      set({ notes: get().notes.filter((n) => n.id !== id) });
    },
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest test/state/notesStore.test.ts`
Expected: PASS (3/3)

- [ ] **Step 5: Write the failing test for the lists store**

Create `test/state/listsStore.test.ts`:

```ts
import { openMigratedDatabase, type OpSqliteDb } from '../../src/db/connection';
import { createListsStore } from '../../src/state/listsStore';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('lists store', () => {
  let dir: string;
  let db: OpSqliteDb;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'yunote-lists-store-test-'));
    db = await openMigratedDatabase({ name: 'test.sqlite', location: dir });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('loadLists populates the lists slice', async () => {
    const store = createListsStore(db);
    await store.getState().createList('Покупки');

    await store.getState().loadLists();

    expect(store.getState().lists.map((l) => l.title)).toEqual(['Покупки']);
  });

  it('addItem updates the itemsByListId slice for that list only', async () => {
    const store = createListsStore(db);
    const list = await store.getState().createList('Покупки');

    await store.getState().addItem(list.id, 'Молоко');

    expect(store.getState().itemsByListId[list.id]?.map((i) => i.text)).toEqual(['Молоко']);
  });

  it('toggleItem flips checked in both the database and the slice', async () => {
    const store = createListsStore(db);
    const list = await store.getState().createList('Покупки');
    const item = await store.getState().addItem(list.id, 'Молоко');

    await store.getState().toggleItem(list.id, item.id);

    expect(store.getState().itemsByListId[list.id]?.[0]?.checked).toBe(true);
  });

  it('removeItem removes it from the slice for that list', async () => {
    const store = createListsStore(db);
    const list = await store.getState().createList('Покупки');
    const item = await store.getState().addItem(list.id, 'Молоко');

    await store.getState().removeItem(list.id, item.id);

    expect(store.getState().itemsByListId[list.id]).toEqual([]);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx jest test/state/listsStore.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 7: Write `src/state/listsStore.ts`**

```ts
import { create, type StoreApi, type UseBoundStore } from 'zustand';
import type { OpSqliteDb } from '../db/connection';
import {
  createList as repoCreateList,
  deleteList as repoDeleteList,
  listLists,
  addListItem,
  updateListItem,
  deleteListItem,
  listItemsForList,
  type List,
  type ListItem,
} from '../data/lists';

interface ListsState {
  lists: List[];
  itemsByListId: Record<string, ListItem[]>;
  loadLists(): Promise<void>;
  createList(title: string): Promise<List>;
  deleteList(id: string): Promise<void>;
  loadItems(listId: string): Promise<void>;
  addItem(listId: string, text: string): Promise<ListItem>;
  toggleItem(listId: string, itemId: string): Promise<void>;
  removeItem(listId: string, itemId: string): Promise<void>;
}

export function createListsStore(db: OpSqliteDb): UseBoundStore<StoreApi<ListsState>> {
  return create<ListsState>((set, get) => ({
    lists: [],
    itemsByListId: {},
    async loadLists() {
      const lists = await listLists(db);
      set({ lists });
    },
    async createList(title) {
      const list = await repoCreateList(db, title);
      set({ lists: [list, ...get().lists] });
      return list;
    },
    async deleteList(id) {
      await repoDeleteList(db, id);
      const { [id]: _removed, ...rest } = get().itemsByListId;
      set({ lists: get().lists.filter((l) => l.id !== id), itemsByListId: rest });
    },
    async loadItems(listId) {
      const items = await listItemsForList(db, listId);
      set({ itemsByListId: { ...get().itemsByListId, [listId]: items } });
    },
    async addItem(listId, text) {
      const item = await addListItem(db, listId, text);
      const existing = get().itemsByListId[listId] ?? [];
      set({ itemsByListId: { ...get().itemsByListId, [listId]: [...existing, item] } });
      return item;
    },
    async toggleItem(listId, itemId) {
      const existing = get().itemsByListId[listId] ?? [];
      const current = existing.find((i) => i.id === itemId);
      const updated = await updateListItem(db, itemId, { checked: !current?.checked });
      set({
        itemsByListId: {
          ...get().itemsByListId,
          [listId]: existing.map((i) => (i.id === itemId ? updated : i)),
        },
      });
    },
    async removeItem(listId, itemId) {
      await deleteListItem(db, itemId);
      const existing = get().itemsByListId[listId] ?? [];
      set({ itemsByListId: { ...get().itemsByListId, [listId]: existing.filter((i) => i.id !== itemId) } });
    },
  }));
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx jest test/state/listsStore.test.ts`
Expected: PASS (4/4)

- [ ] **Step 9: Write the failing test for the classes store**

Create `test/state/classesStore.test.ts`:

```ts
import { openMigratedDatabase, type OpSqliteDb } from '../../src/db/connection';
import { createClassesStore } from '../../src/state/classesStore';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('classes store', () => {
  let dir: string;
  let db: OpSqliteDb;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'yunote-classes-store-test-'));
    db = await openMigratedDatabase({ name: 'test.sqlite', location: dir });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('createClass updates the slice without a separate reload', async () => {
    const store = createClassesStore(db);

    await store.getState().createClass('Работа');

    expect(store.getState().classes.map((c) => c.name)).toEqual(['Работа']);
  });

  it('deleteClass removes it from the slice', async () => {
    const store = createClassesStore(db);
    const cls = await store.getState().createClass('Работа');

    await store.getState().deleteClass(cls.id);

    expect(store.getState().classes).toEqual([]);
  });
});
```

- [ ] **Step 10: Run test to verify it fails**

Run: `npx jest test/state/classesStore.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 11: Write `src/state/classesStore.ts`**

```ts
import { create, type StoreApi, type UseBoundStore } from 'zustand';
import type { OpSqliteDb } from '../db/connection';
import { createClass as repoCreateClass, deleteClass as repoDeleteClass, listClasses, type Class } from '../data/classes';

interface ClassesState {
  classes: Class[];
  loadClasses(): Promise<void>;
  createClass(name: string): Promise<Class>;
  deleteClass(id: string): Promise<void>;
}

export function createClassesStore(db: OpSqliteDb): UseBoundStore<StoreApi<ClassesState>> {
  return create<ClassesState>((set, get) => ({
    classes: [],
    async loadClasses() {
      const classes = await listClasses(db);
      set({ classes });
    },
    async createClass(name) {
      const cls = await repoCreateClass(db, name);
      set({ classes: [...get().classes, cls] });
      return cls;
    },
    async deleteClass(id) {
      await repoDeleteClass(db, id);
      set({ classes: get().classes.filter((c) => c.id !== id) });
    },
  }));
}
```

- [ ] **Step 12: Run test to verify it passes**

Run: `npx jest test/state/classesStore.test.ts`
Expected: PASS (2/2)

- [ ] **Step 13: Run the full suite**

Run: `npx jest`
Expected: PASS — all suites across Tasks 1-7 green.

- [ ] **Step 14: Commit**

```bash
git add src/state/notesStore.ts src/state/listsStore.ts src/state/classesStore.ts test/state/notesStore.test.ts test/state/listsStore.test.ts test/state/classesStore.test.ts
git commit -m "feat: add Zustand stores for notes, lists, and classes"
```
