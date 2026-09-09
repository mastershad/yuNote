# yuNote Relay Step 3 — Native Shell, Local Transport, Action Dispatcher, Sync Outbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `yuNote` a real native Android shell and the local-side machinery (transport port, action dispatcher, sync outbox, `rev`-aware schema) needed to actually apply a `StructuredAction` relayed from Key Fob, and to push local mutations back — everything Steps 1-2 built server-side now has somewhere to land.

**Architecture:** This is Step 3 of 6 in the yuNote↔Key Fob local-relay design (see Spec, in the sibling `IoT-Key-Fob-Project` repo). Steps 1-2 (shipped) built the `cloud-platform`/`n8n` producer side: a `rev`-aware replica, the `StructuredAction` contract, and the graph wiring that builds one for all 10 mutating-verb combinations. This plan builds the *consumer* side, entirely within this repo (`yuNote`), scoped to what's achievable and testable on this machine (Windows, no Xcode):

- A `rev` column + a `sync_outbox` tombstone-aware dirty-tracking table (new local schema migration).
- Every mutation (`createNote`/`updateNote`/`deleteNote`/`createList`/`addListItem`/`updateListItem`/`deleteListItem`) bumps `rev` and marks the entity dirty in the outbox — the single-writer principle the spec calls out (§5.4): there is no second write path, so this is the only place that needs to change for both manual UI edits and applied Structured Actions to sync correctly.
- `createNote`/`createList`/`addListItem` gain an optional caller-supplied `id` — a real gap found while planning: they currently always mint their own id via `generateId()`, but a `StructuredAction`'s `Capture` carries a server-synthesized `targetId` that the local row *must* use, or the cloud replica and the local row end up as two different entities.
- `LocalTransport`, the port from spec §3.4, plus `InMemoryLocalTransport` — a Jest-mockable double, not a simulator.
- `ActionDispatcher` — translates an incoming `structured-action` message into the exact same repository calls a manual UI edit would make.
- The sync outbox's *push* side — reads dirty rows, batches them into one `sync-push` message, and the `linked`/`unlinked`/`sync-ack` handlers from spec §4/§5.6.
- A bare Android native shell (`android/`), so the app can actually build and run on this platform.

**Explicitly out of scope for this plan** (confirmed with the human partner before this plan was written):
- **iOS native scaffolding** — this machine has no Xcode/macOS; physically cannot be done or verified here. A separate plan, on separate hardware, later.
- **Real platform transport adapters** (`AndroidLocalTransport`'s Intent-extras/FileProvider wiring, any iOS adapter) — genuine native-platform work (a thin native module or an as-yet-unresearched RN community package), deferred to a "Step 3b" once ready to focus on that specifically. This plan only builds the `LocalTransport` *port* and its in-memory test double.
- **UI screens** (Notes/Lists tabs, gestures) — spec's own §13 sequencing places these in Step 5, "wired to a real shell" that this plan is what provides.
- **Whole-list Structured Actions** (`targetType: 'list'` Capture/Modify/Remove) — the shipped `n8n` graph (Step 2) never actually produces one today (confirmed by reading its code during Step 2's planning); `ActionDispatcher` handles the case defensively (logs, no-op, reports failure) rather than pretending to support it.

**Tech Stack:** TypeScript/Jest (all of Tasks 1-5 — real `better-sqlite3`-backed `op-sqlite` Node façade, no native dependency, matching this repo's existing test convention exactly). React Native CLI + Android SDK/Gradle (Task 6 only — this machine has Java 17 and `ANDROID_HOME` set, confirmed before writing this plan).

**Spec:** `../IoT-Key-Fob-Project/docs/superpowers/specs/2026-09-08-yunote-keyfob-relay-and-sync-design.md` (the relay design — §3, §4, §5, §7, §8, §9, §13) and this repo's own `docs/superpowers/specs/2026-09-07-yunote-local-app-design.md` (existing local data layer this plan builds on top of, not against).

## Global Constraints

- **Single-writer principle (spec §5.4) is load-bearing**: `ActionDispatcher` must call the *same* repository functions (`createNote`, `updateNote`, `addListItem`, etc.) a manual UI edit would call — never a second, parallel write path. Every task in this plan that touches those functions must keep that true.
- **`rev` semantics (spec §5.1/§5.3)**: incremented by 1 on every local mutation, whether user-initiated or an applied Structured Action. A fresh `createNote`/`createList`/`addListItem` starts at `rev = 1` (the column's own `DEFAULT 1` — no code needs to set it explicitly on insert). Every `updateNote`/`updateListItem` must bump the existing row's `rev` by 1 (read-then-write, not a raw `rev = rev + 1` SQL expression — the in-memory returned object needs the new value too).
- **`classes` never syncs** — this repo's existing migration comment states this is enforced structurally, not by filtering: the `classes` table has no `synced_at` column, so sync code literally cannot act on it. This plan's new `rev` column and `sync_outbox` entries follow the identical rule — `classes` gets neither.
- **The generated-id format must be a real UUIDv4** (via the existing `generateId()` in `src/data/id.ts`), matching this repo's own established id scheme (spec §5.1: "No new ID scheme needed — yuNote already generates client-side UUIDv4s"). This is *not* the same decision the sibling `cloud-platform` repo made for its own synthetic ids (`yn-<timestamp>-<random>`, chosen there specifically to avoid an unverified `crypto.randomUUID()` assumption inside an `n8n` Code-node sandbox) — that constraint doesn't apply here, since this is a normal Node/RN environment and `generateId()` already works today.
- **Migration discipline**: follow `src/db/connection.ts`'s existing pattern exactly — a new `Migration` object appended to the `migrations` array, DDL and the `PRAGMA user_version` write both inside one `db.transaction`, tested the same way `test/db/connection.test.ts` already tests migration 1 (idempotency, atomicity-on-failure, exact table/column shape).
- **Test conventions**: every test in Tasks 1-5 uses a real file-backed SQLite via `openMigratedDatabase({ name: 'test.sqlite', location: dir })` against a fresh `mkdtempSync` temp dir per test, exactly like every existing test in `test/data/` and `test/db/` — never a mock of `OpSqliteDb` itself.
- **`npm test` (baseline: 41 tests, all green) and `npm run typecheck` must stay green after every task.**
- Task 6 (Android shell) is the one task in this plan not driven by Jest — its own section states its own verification method.

---

## Task 1: Schema migration — `rev` columns + `sync_outbox` table (migration version 2)

**Files:**
- Modify: `src/db/connection.ts`
- Test: `test/db/connection.test.ts`

**Interfaces:**
- Produces: `notes`, `lists`, `list_items` each gain `rev INTEGER NOT NULL DEFAULT 1`. A new table `sync_outbox` tracks dirty entities pending push, including deletions (a tombstone — the row itself is gone, but the outbox still needs to tell Key Fob to relay a delete):
  ```sql
  CREATE TABLE sync_outbox (
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0,
    transfer_id TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (entity_type, entity_id)
  )
  ```
  `transfer_id` is set once a row has been included in an in-flight `sync-push` (Task 5's job) and cleared/removed on `sync-ack`; `NULL` means "dirty, not yet sent." `entity_type` is `'note' | 'list' | 'listItem'`.

- [ ] **Step 1: Write the failing migration test**

Add to `test/db/connection.test.ts`, in the same `describe('openMigratedDatabase', ...)` block:

```typescript
  it('migration 2 adds a rev column (default 1) to notes/lists/list_items but not classes', async () => {
    const db = await openMigratedDatabase({ name: 'test.sqlite', location: dir });

    try {
      for (const table of ['notes', 'lists', 'list_items']) {
        const { rows } = await db.execute(`SELECT * FROM pragma_table_info('${table}')`);
        const revColumn = rows?.find((r) => r.name === 'rev');
        expect(revColumn).toBeDefined();
        expect(revColumn?.dflt_value).toBe('1');
      }

      const { rows: classesColumns } = await db.execute("SELECT * FROM pragma_table_info('classes')");
      expect(classesColumns?.some((r) => r.name === 'rev')).toBe(false);
    } finally {
      db.close();
    }
  });

  it('migration 2 adds a sync_outbox table with no rows initially', async () => {
    const db = await openMigratedDatabase({ name: 'test.sqlite', location: dir });

    try {
      const { rows: tables } = await db.execute("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name");
      expect(tables?.map((r) => r.name)).toEqual(['classes', 'list_items', 'lists', 'notes', 'sync_outbox']);

      const { rows } = await db.execute('SELECT * FROM sync_outbox');
      expect(rows).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('sets user_version to 2 after running both migrations', async () => {
    const db = await openMigratedDatabase({ name: 'test.sqlite', location: dir });

    try {
      const { rows } = await db.execute('SELECT * FROM pragma_user_version()');
      expect(rows?.[0]?.user_version).toBe(2);
    } finally {
      db.close();
    }
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest test/db/connection.test.ts -t "migration 2"`
Expected: FAIL — `sync_outbox` doesn't exist, `rev` column doesn't exist, `user_version` is still 1.

- [ ] **Step 3: Implement**

In `src/db/connection.ts`, append a second entry to the `migrations` array (after the existing `version: 1` entry):

```typescript
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest test/db/connection.test.ts`
Expected: PASS — full file green (existing migration-1 tests plus the 3 new ones).

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npm test` — expected PASS, no regressions (baseline 41 tests; this task adds 3, so expect 44).
Run: `npm run typecheck` — expected clean.

- [ ] **Step 6: Commit**

```bash
git add src/db/connection.ts test/db/connection.test.ts
git commit -m "feat: add rev columns and sync_outbox table (migration 2)"
```

---

## Task 2: `rev` bump + dirty-marking on every mutation, and explicit-id support on every create

**Files:**
- Modify: `src/data/notes.ts`
- Modify: `src/data/lists.ts`
- Test: `test/data/notes.test.ts`
- Test: `test/data/lists.test.ts`

**Interfaces:**
- Consumes: Task 1's `rev`/`sync_outbox` columns.
- Produces:
  - `createNote(db, input: { title, content, classId?, id? })` — `id` optional, defaults to `generateId()` when omitted (every existing call site keeps working unchanged).
  - `createList(db, title, options?: { id?: string })` — same pattern.
  - `addListItem(db, listId, text, options?: { id?: string })` — same pattern.
  - Every `create*`/`update*`/`delete*` function marks the affected entity dirty in `sync_outbox` (upsert with `transfer_id = NULL`, `deleted = 1` for the delete functions) in the *same transaction* as the data mutation.
  - Every `update*` function bumps the row's `rev` by 1 in the same UPDATE statement, and returns the new `rev` in the object it hands back (widen the `Note`/`List`/`ListItem` interfaces to include `rev: number`).
  - This is what Task 4 (`ActionDispatcher`) and Task 5 (sync outbox push) both build on: a `StructuredAction`'s `Capture` can now land at the exact id the cloud replica expects, and *any* mutation (manual or dispatched) automatically becomes sync-outbox-visible with no separate code path.

- [ ] **Step 1: Write the failing tests for `createNote`'s explicit id**

Add to `test/data/notes.test.ts`:

```typescript
  it('createNote uses a caller-supplied id when given one', async () => {
    const note = await createNote(db, { title: 'Идея', content: 'текст', id: 'explicit-id-1' });
    expect(note.id).toBe('explicit-id-1');

    const all = await listNotes(db, { sort: 'date-desc' });
    expect(all.map((n) => n.id)).toEqual(['explicit-id-1']);
  });

  it('createNote still generates a fresh id when none is given', async () => {
    const note = await createNote(db, { title: 'Идея', content: 'текст' });
    expect(note.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('createNote starts rev at 1', async () => {
    const note = await createNote(db, { title: 'Идея', content: 'текст' });
    expect(note.rev).toBe(1);
  });

  it('updateNote bumps rev by 1 on every call', async () => {
    const note = await createNote(db, { title: 'Идея', content: 'текст' });
    const once = await updateNote(db, note.id, { title: 'Новое' });
    expect(once.rev).toBe(2);
    const twice = await updateNote(db, note.id, { content: 'ещё текст' });
    expect(twice.rev).toBe(3);
  });

  it('createNote marks the new note dirty in sync_outbox', async () => {
    const note = await createNote(db, { title: 'Идея', content: 'текст' });
    const { rows } = await db.execute('SELECT * FROM sync_outbox WHERE entity_id = ?', [note.id]);
    expect(rows).toEqual([
      expect.objectContaining({ entity_type: 'note', entity_id: note.id, deleted: 0, transfer_id: null }),
    ]);
  });

  it('updateNote re-marks the note dirty in sync_outbox (idempotent upsert, not a duplicate row)', async () => {
    const note = await createNote(db, { title: 'Идея', content: 'текст' });
    await updateNote(db, note.id, { title: 'Новое' });
    const { rows } = await db.execute('SELECT * FROM sync_outbox WHERE entity_id = ?', [note.id]);
    expect(rows?.length).toBe(1);
  });

  it('deleteNote marks the note as a deleted tombstone in sync_outbox instead of removing the outbox row', async () => {
    const note = await createNote(db, { title: 'Идея', content: 'текст' });
    await deleteNote(db, note.id);
    const { rows } = await db.execute('SELECT * FROM sync_outbox WHERE entity_id = ?', [note.id]);
    expect(rows).toEqual([
      expect.objectContaining({ entity_type: 'note', entity_id: note.id, deleted: 1 }),
    ]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest test/data/notes.test.ts -t "createNote uses a caller-supplied id"`
Expected: FAIL — `createNote` doesn't accept an `id` field on `input` today (TypeScript would reject it, or if loosely typed, it's silently ignored and a fresh UUID is used instead).

- [ ] **Step 3: Implement the notes side**

Replace `src/data/notes.ts` in full:

```typescript
import type { OpSqliteDb } from '../db/connection';
import { generateId, nowIso } from './id';

export interface Note {
  id: string;
  title: string;
  content: string;
  classId: string | null;
  rev: number;
  createdAt: string;
  updatedAt: string;
}

interface NoteRow {
  id: string;
  title: string;
  content: string;
  class_id: string | null;
  rev: number;
  created_at: string;
  updated_at: string;
}

function toNote(row: NoteRow): Note {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    classId: row.class_id,
    rev: row.rev,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function markDirty(
  db: OpSqliteDb,
  entityType: 'note' | 'list' | 'listItem',
  entityId: string,
  deleted: boolean,
): Promise<void> {
  await db.execute(
    `INSERT INTO sync_outbox (entity_type, entity_id, deleted, transfer_id, created_at)
     VALUES (?, ?, ?, NULL, ?)
     ON CONFLICT (entity_type, entity_id) DO UPDATE SET
       deleted = excluded.deleted, transfer_id = NULL, created_at = excluded.created_at`,
    [entityType, entityId, deleted ? 1 : 0, nowIso()],
  );
}

export async function createNote(
  db: OpSqliteDb,
  input: { title: string; content: string; classId?: string; id?: string },
): Promise<Note> {
  const id = input.id ?? generateId();
  const timestamp = nowIso();
  const classId = input.classId ?? null;
  await db.transaction(async (tx) => {
    await tx.execute(
      'INSERT INTO notes (id, title, content, class_id, rev, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)',
      [id, input.title, input.content, classId, timestamp, timestamp],
    );
    await markDirty(tx as unknown as OpSqliteDb, 'note', id, false);
  });
  return { id, title: input.title, content: input.content, classId, rev: 1, createdAt: timestamp, updatedAt: timestamp };
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
    rev: existing.rev + 1,
    updatedAt: nowIso(),
  };

  await db.transaction(async (tx) => {
    await tx.execute(
      'UPDATE notes SET title = ?, content = ?, class_id = ?, rev = ?, updated_at = ? WHERE id = ?',
      [next.title, next.content, next.classId, next.rev, next.updatedAt, id],
    );
    await markDirty(tx as unknown as OpSqliteDb, 'note', id, false);
  });

  return next;
}

export async function deleteNote(db: OpSqliteDb, id: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute('DELETE FROM notes WHERE id = ?', [id]);
    await markDirty(tx as unknown as OpSqliteDb, 'note', id, true);
  });
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

Note on `tx as unknown as OpSqliteDb`: `markDirty` only calls `.execute`, which is exactly the `OpSqliteExecutor` surface `tx` already has (see `src/db/connection.ts`'s `OpSqliteExecutor`/`OpSqliteDb` split) — this cast is a narrowing convenience, not a lie about capability. If this reads awkwardly to the implementer, `markDirty`'s parameter type can be changed to `OpSqliteExecutor` (imported from `../db/connection`) instead of `OpSqliteDb`, dropping the cast entirely — functionally identical, and arguably clearer since it's what `markDirty` actually needs. Either is acceptable; prefer the `OpSqliteExecutor`-typed version if starting fresh.

- [ ] **Step 4: Run the notes tests to verify they pass**

Run: `npx jest test/data/notes.test.ts`
Expected: PASS — full file green.

- [ ] **Step 5: Write the failing tests for the lists side**

Add to `test/data/lists.test.ts` (create the file's `describe` block for `sync_outbox` interactions if it doesn't already import `db` the same way `notes.test.ts` does — check the existing file's setup first and match its pattern):

```typescript
  it('createList uses a caller-supplied id when given one', async () => {
    const list = await createList(db, 'Покупки', { id: 'explicit-list-id-1' });
    expect(list.id).toBe('explicit-list-id-1');
  });

  it('addListItem uses a caller-supplied id when given one', async () => {
    const list = await createList(db, 'Покупки');
    const item = await addListItem(db, list.id, 'Молоко', { id: 'explicit-item-id-1' });
    expect(item.id).toBe('explicit-item-id-1');
  });

  it('createList starts rev at 1; updateListItem bumps rev by 1', async () => {
    const list = await createList(db, 'Покупки');
    expect(list.rev).toBe(1);

    const item = await addListItem(db, list.id, 'Молоко');
    expect(item.rev).toBe(1);

    const updated = await updateListItem(db, item.id, { checked: true });
    expect(updated.rev).toBe(2);
  });

  it('createList and addListItem each mark their entity dirty in sync_outbox', async () => {
    const list = await createList(db, 'Покупки');
    const item = await addListItem(db, list.id, 'Молоко');

    const { rows: listRows } = await db.execute('SELECT * FROM sync_outbox WHERE entity_id = ?', [list.id]);
    expect(listRows).toEqual([expect.objectContaining({ entity_type: 'list', entity_id: list.id, deleted: 0 })]);

    const { rows: itemRows } = await db.execute('SELECT * FROM sync_outbox WHERE entity_id = ?', [item.id]);
    expect(itemRows).toEqual([expect.objectContaining({ entity_type: 'listItem', entity_id: item.id, deleted: 0 })]);
  });

  it('deleteListItem tombstones in sync_outbox; deleteList tombstones the list but not its already-deleted items', async () => {
    const list = await createList(db, 'Покупки');
    const item = await addListItem(db, list.id, 'Молоко');

    await deleteListItem(db, item.id);
    const { rows: itemRows } = await db.execute('SELECT * FROM sync_outbox WHERE entity_id = ?', [item.id]);
    expect(itemRows).toEqual([expect.objectContaining({ deleted: 1 })]);

    await deleteList(db, list.id);
    const { rows: listRows } = await db.execute('SELECT * FROM sync_outbox WHERE entity_id = ?', [list.id]);
    expect(listRows).toEqual([expect.objectContaining({ deleted: 1 })]);
  });
```

- [ ] **Step 6: Run the tests to verify they fail**

Run: `npx jest test/data/lists.test.ts -t "caller-supplied id"`
Expected: FAIL.

- [ ] **Step 7: Implement the lists side**

Replace `src/data/lists.ts` in full:

```typescript
import type { OpSqliteDb } from '../db/connection';
import { generateId, nowIso } from './id';

export interface List {
  id: string;
  title: string;
  rev: number;
  createdAt: string;
  updatedAt: string;
}

export interface ListItem {
  id: string;
  listId: string;
  text: string;
  checked: boolean;
  rev: number;
  createdAt: string;
  updatedAt: string;
}

interface ListRow {
  id: string;
  title: string;
  rev: number;
  created_at: string;
  updated_at: string;
}

interface ListItemRow {
  id: string;
  list_id: string;
  text: string;
  checked: number;
  rev: number;
  created_at: string;
  updated_at: string;
}

function toList(row: ListRow): List {
  return { id: row.id, title: row.title, rev: row.rev, createdAt: row.created_at, updatedAt: row.updated_at };
}

function toListItem(row: ListItemRow): ListItem {
  return {
    id: row.id,
    listId: row.list_id,
    text: row.text,
    checked: row.checked === 1,
    rev: row.rev,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function markDirty(
  db: OpSqliteDb,
  entityType: 'note' | 'list' | 'listItem',
  entityId: string,
  deleted: boolean,
): Promise<void> {
  await db.execute(
    `INSERT INTO sync_outbox (entity_type, entity_id, deleted, transfer_id, created_at)
     VALUES (?, ?, ?, NULL, ?)
     ON CONFLICT (entity_type, entity_id) DO UPDATE SET
       deleted = excluded.deleted, transfer_id = NULL, created_at = excluded.created_at`,
    [entityType, entityId, deleted ? 1 : 0, nowIso()],
  );
}

export async function createList(db: OpSqliteDb, title: string, options?: { id?: string }): Promise<List> {
  const id = options?.id ?? generateId();
  const timestamp = nowIso();
  await db.transaction(async (tx) => {
    await tx.execute('INSERT INTO lists (id, title, rev, created_at, updated_at) VALUES (?, ?, 1, ?, ?)', [
      id,
      title,
      timestamp,
      timestamp,
    ]);
    await markDirty(tx as unknown as OpSqliteDb, 'list', id, false);
  });
  return { id, title, rev: 1, createdAt: timestamp, updatedAt: timestamp };
}

export async function deleteList(db: OpSqliteDb, id: string): Promise<void> {
  // Cascades to items, deliberately unlike deleteClass -- a list's items
  // aren't meaningful without the list, whereas a class is just a label.
  // Each item's own tombstone (from a prior deleteListItem call, or one
  // this function would need to write per item) is deliberately NOT
  // written here for items that were never individually deleted --
  // Key Fob/cloud-platform's own DELETE /yunote/sync/lists/:id already
  // cascades the same way server-side (yunoteSyncStore.deleteList), so
  // one tombstone for the list is sufficient; the items simply vanish
  // from both sides without needing their own delete messages.
  const { rows } = await db.execute('SELECT id FROM list_items WHERE list_id = ?', [id]);
  await db.transaction(async (tx) => {
    await tx.execute('DELETE FROM list_items WHERE list_id = ?', [id]);
    await tx.execute('DELETE FROM lists WHERE id = ?', [id]);
    await markDirty(tx as unknown as OpSqliteDb, 'list', id, true);
    for (const row of (rows ?? []) as { id: string }[]) {
      // Remove any outbox entry the deleted items already had queued --
      // there's nothing left to push for them now that the whole list is
      // gone, and leaving a stale non-deleted entry would make the next
      // flush try to sync an item whose list no longer exists.
      await tx.execute('DELETE FROM sync_outbox WHERE entity_type = ? AND entity_id = ?', ['listItem', row.id]);
    }
  });
}

export async function listLists(db: OpSqliteDb): Promise<List[]> {
  const { rows } = await db.execute('SELECT * FROM lists ORDER BY updated_at DESC');
  return ((rows ?? []) as unknown as ListRow[]).map(toList);
}

export async function addListItem(
  db: OpSqliteDb,
  listId: string,
  text: string,
  options?: { id?: string },
): Promise<ListItem> {
  const id = options?.id ?? generateId();
  const timestamp = nowIso();
  await db.transaction(async (tx) => {
    await tx.execute(
      'INSERT INTO list_items (id, list_id, text, checked, rev, created_at, updated_at) VALUES (?, ?, ?, 0, 1, ?, ?)',
      [id, listId, text, timestamp, timestamp],
    );
    await markDirty(tx as unknown as OpSqliteDb, 'listItem', id, false);
  });
  return { id, listId, text, checked: false, rev: 1, createdAt: timestamp, updatedAt: timestamp };
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
    rev: existing.rev + 1,
    updatedAt: nowIso(),
  };

  await db.transaction(async (tx) => {
    await tx.execute('UPDATE list_items SET text = ?, checked = ?, rev = ?, updated_at = ? WHERE id = ?', [
      next.text,
      next.checked ? 1 : 0,
      next.rev,
      next.updatedAt,
      id,
    ]);
    await markDirty(tx as unknown as OpSqliteDb, 'listItem', id, false);
  });

  return next;
}

export async function deleteListItem(db: OpSqliteDb, id: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute('DELETE FROM list_items WHERE id = ?', [id]);
    await markDirty(tx as unknown as OpSqliteDb, 'listItem', id, true);
  });
}

export async function listItemsForList(db: OpSqliteDb, listId: string): Promise<ListItem[]> {
  const { rows } = await db.execute('SELECT * FROM list_items WHERE list_id = ? ORDER BY created_at ASC', [listId]);
  return ((rows ?? []) as unknown as ListItemRow[]).map(toListItem);
}
```

- [ ] **Step 8: Run the lists tests to verify they pass**

Run: `npx jest test/data/lists.test.ts`
Expected: PASS.

- [ ] **Step 9: Fix the two state-store test files' now-stale type expectations**

`test/state/notesStore.test.ts` and `test/state/listsStore.test.ts` may assert on the exact shape of a returned `Note`/`List`/`ListItem` object (e.g. `toEqual({...})` without a `rev` field). Run `npm test` first (Step 10) to find out; if any such assertion fails only because it's missing the new `rev: 1` field, add `rev: 1` (or `rev: 2` for a post-update assertion, matching Step 3's now-doubled-per-update-call pattern) to that specific expected object — this is a mechanical fix to keep an existing test's assertion complete, not a behavior change.

- [ ] **Step 10: Run the full suite and typecheck**

Run: `npm test` — expected PASS, no regressions beyond the mechanical fixes from Step 9 (baseline 44 after Task 1; this task adds 12 new tests across the two files — 7 in `notes.test.ts`, 5 in `lists.test.ts` — so expect 56).
Run: `npm run typecheck` — expected clean.

- [ ] **Step 11: Commit**

```bash
git add src/data/notes.ts src/data/lists.ts test/data/notes.test.ts test/data/lists.test.ts test/state/notesStore.test.ts test/state/listsStore.test.ts
git commit -m "feat: bump rev and mark sync_outbox dirty on every mutation; accept explicit ids on create"
```

---

## Task 3: `LocalTransport` port + `InMemoryLocalTransport`

**Files:**
- Create: `src/relay/localTransport.ts`
- Create: `src/relay/inMemoryLocalTransport.ts`
- Test: `test/relay/inMemoryLocalTransport.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  export interface LocalTransportMessage {
    transferId: string;
    kind: 'linked' | 'unlinked' | 'structured-action' | 'sync-push' | 'sync-ack' | 'sync-error';
    small?: Record<string, unknown>;
    largeRef?: { path: string; sizeBytes: number };
  }

  export interface LocalTransport {
    send(message: LocalTransportMessage): Promise<void>;
    onReceive(handler: (message: LocalTransportMessage) => Promise<void>): () => void;
    acknowledge(transferId: string): Promise<void>;
  }
  ```
  and a factory `createInMemoryLocalTransport()` returning a `LocalTransport` plus test-inspection members (`sentMessages: LocalTransportMessage[]`, `acknowledgedIds: string[]`, `simulateReceive(message: LocalTransportMessage): Promise<void>`) — a controllable test double, not a bidirectional simulator, matching this project's established mock-outside-the-interface pattern (spec §3.4 cites `cloud-platform`'s `EmailSender` console/test doubles as the precedent).
- Consumed by: Task 4 (`ActionDispatcher` registers via `onReceive`) and Task 5 (sync outbox calls `send`).

- [ ] **Step 1: Write the failing tests**

Create `test/relay/inMemoryLocalTransport.test.ts`:

```typescript
import { createInMemoryLocalTransport } from '../../src/relay/inMemoryLocalTransport';
import type { LocalTransportMessage } from '../../src/relay/localTransport';

describe('InMemoryLocalTransport', () => {
  it('records every sent message in order', async () => {
    const transport = createInMemoryLocalTransport();
    const messageA: LocalTransportMessage = { transferId: 'a', kind: 'sync-push', small: { foo: 1 } };
    const messageB: LocalTransportMessage = { transferId: 'b', kind: 'sync-push', small: { foo: 2 } };

    await transport.send(messageA);
    await transport.send(messageB);

    expect(transport.sentMessages).toEqual([messageA, messageB]);
  });

  it('delivers a simulated incoming message to every registered handler', async () => {
    const transport = createInMemoryLocalTransport();
    const received: LocalTransportMessage[] = [];
    transport.onReceive(async (message) => {
      received.push(message);
    });

    const incoming: LocalTransportMessage = { transferId: 'x', kind: 'structured-action', small: { verb: 'Capture' } };
    await transport.simulateReceive(incoming);

    expect(received).toEqual([incoming]);
  });

  it('onReceive returns an unsubscribe function that stops delivery to that handler', async () => {
    const transport = createInMemoryLocalTransport();
    const received: LocalTransportMessage[] = [];
    const unsubscribe = transport.onReceive(async (message) => {
      received.push(message);
    });

    unsubscribe();
    await transport.simulateReceive({ transferId: 'x', kind: 'linked', small: {} });

    expect(received).toEqual([]);
  });

  it('acknowledge records the transferId', async () => {
    const transport = createInMemoryLocalTransport();

    await transport.acknowledge('some-transfer-id');

    expect(transport.acknowledgedIds).toEqual(['some-transfer-id']);
  });

  it('a handler that throws does not prevent acknowledge from being callable independently, and the error propagates to the caller of simulateReceive', async () => {
    const transport = createInMemoryLocalTransport();
    transport.onReceive(async () => {
      throw new Error('handler failed');
    });

    await expect(transport.simulateReceive({ transferId: 'x', kind: 'linked', small: {} })).rejects.toThrow(
      'handler failed',
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest test/relay/inMemoryLocalTransport.test.ts`
Expected: FAIL — the module doesn't exist yet.

- [ ] **Step 3: Implement the port type**

Create `src/relay/localTransport.ts`:

```typescript
/**
 * The shared local-transport abstraction both apps (yuNote and Key Fob)
 * implement, one platform adapter each -- design spec §3.4. This repo
 * builds only the port and its in-memory test double (this plan's Task 3);
 * the real platform adapters (Android Intent-extras/FileProvider, any iOS
 * equivalent) are explicitly out of scope, deferred to a later plan.
 */
export interface LocalTransportMessage {
  transferId: string;
  kind: 'linked' | 'unlinked' | 'structured-action' | 'sync-push' | 'sync-ack' | 'sync-error';
  small?: Record<string, unknown>;
  largeRef?: { path: string; sizeBytes: number };
}

export interface LocalTransport {
  send(message: LocalTransportMessage): Promise<void>;
  // Registers a handler; returns an unsubscribe function. The handler must
  // call `acknowledge` itself once it has durably applied the message --
  // acknowledge is not automatic, so a handler that throws (or the process
  // dies mid-apply) leaves the message pending for retry.
  onReceive(handler: (message: LocalTransportMessage) => Promise<void>): () => void;
  acknowledge(transferId: string): Promise<void>;
}
```

- [ ] **Step 4: Implement the in-memory double**

Create `src/relay/inMemoryLocalTransport.ts`:

```typescript
import type { LocalTransport, LocalTransportMessage } from './localTransport';

export interface InMemoryLocalTransport extends LocalTransport {
  readonly sentMessages: LocalTransportMessage[];
  readonly acknowledgedIds: string[];
  simulateReceive(message: LocalTransportMessage): Promise<void>;
}

export function createInMemoryLocalTransport(): InMemoryLocalTransport {
  const sentMessages: LocalTransportMessage[] = [];
  const acknowledgedIds: string[] = [];
  const handlers = new Set<(message: LocalTransportMessage) => Promise<void>>();

  return {
    sentMessages,
    acknowledgedIds,
    async send(message) {
      sentMessages.push(message);
    },
    onReceive(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    async acknowledge(transferId) {
      acknowledgedIds.push(transferId);
    },
    async simulateReceive(message) {
      for (const handler of handlers) {
        await handler(message);
      }
    },
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx jest test/relay/inMemoryLocalTransport.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the full suite and typecheck**

Run: `npm test` — expected PASS, no regressions (baseline 56 after Tasks 1-2; adds 5 tests, so expect 61).
Run: `npm run typecheck` — expected clean.

- [ ] **Step 7: Commit**

```bash
git add src/relay/localTransport.ts src/relay/inMemoryLocalTransport.ts test/relay/inMemoryLocalTransport.test.ts
git commit -m "feat: add LocalTransport port and InMemoryLocalTransport test double"
```

---

## Task 4: `ActionDispatcher`

**Files:**
- Create: `src/relay/actionDispatcher.ts`
- Test: `test/relay/actionDispatcher.test.ts`

**Interfaces:**
- Consumes: Task 2's explicit-id-capable repository functions; Task 3's `LocalTransportMessage`.
- Produces:
  ```typescript
  export interface StructuredAction {
    verb: 'Capture' | 'Modify' | 'Remove' | 'Complete' | 'Clear';
    targetType: 'note' | 'list' | 'listItem';
    targetId: string;
    targetIds?: string[];
    parentListId?: string;
    listName?: string;
    title?: string;
    content?: string;
  }

  export type ActionDispatchResult = { status: 'applied' } | { status: 'failed'; reason: string };

  export async function applyStructuredAction(db: OpSqliteDb, action: StructuredAction): Promise<ActionDispatchResult>;

  // Registers applyStructuredAction against a transport's 'structured-action'
  // messages, acknowledging on success. Returns the same unsubscribe
  // function `transport.onReceive` does.
  export function registerActionDispatcher(db: OpSqliteDb, transport: LocalTransport): () => void;
  ```
  This is the exact shape the shipped `cloud-platform`/`n8n` `StructuredAction` contract produces (`IoT-Key-Fob-Project`'s `cloud-platform/src/contract/workflowResult.ts`) — copied here rather than imported, since the two repos share no package (same convention that contract already follows across its 4 existing declaration sites).

- [ ] **Step 1: Write the failing tests**

Create `test/relay/actionDispatcher.test.ts`:

```typescript
import { openMigratedDatabase, type OpSqliteDb } from '../../src/db/connection';
import { applyStructuredAction, registerActionDispatcher } from '../../src/relay/actionDispatcher';
import { createInMemoryLocalTransport } from '../../src/relay/inMemoryLocalTransport';
import { createNote } from '../../src/data/notes';
import { createList, addListItem, listItemsForList } from '../../src/data/lists';
import { listNotes } from '../../src/data/notes';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('applyStructuredAction', () => {
  let dir: string;
  let db: OpSqliteDb;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'yunote-dispatcher-test-'));
    db = await openMigratedDatabase({ name: 'test.sqlite', location: dir });
  });

  afterEach(() => {
    try {
      db?.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Capture on a note creates it at the server-provided id, with title and content', async () => {
    const result = await applyStructuredAction(db, {
      verb: 'Capture',
      targetType: 'note',
      targetId: 'yn-server-note-1',
      title: 'Идея',
      content: 'Купить билеты',
    });

    expect(result).toEqual({ status: 'applied' });
    const notes = await listNotes(db, { sort: 'date-desc' });
    expect(notes).toEqual([expect.objectContaining({ id: 'yn-server-note-1', title: 'Идея', content: 'Купить билеты' })]);
  });

  it('Modify on a note updates its content, leaving title unchanged', async () => {
    const note = await createNote(db, { title: 'Идея', content: 'старый текст' });

    const result = await applyStructuredAction(db, {
      verb: 'Modify',
      targetType: 'note',
      targetId: note.id,
      content: 'новый текст',
    });

    expect(result).toEqual({ status: 'applied' });
    const notes = await listNotes(db, { sort: 'date-desc' });
    expect(notes).toEqual([expect.objectContaining({ id: note.id, title: 'Идея', content: 'новый текст' })]);
  });

  it('Remove on a note deletes it', async () => {
    const note = await createNote(db, { title: 'Идея', content: 'текст' });

    const result = await applyStructuredAction(db, { verb: 'Remove', targetType: 'note', targetId: note.id });

    expect(result).toEqual({ status: 'applied' });
    expect(await listNotes(db, { sort: 'date-desc' })).toEqual([]);
  });

  it('Clear on notes deletes every id in targetIds', async () => {
    const noteA = await createNote(db, { title: 'A', content: '' });
    const noteB = await createNote(db, { title: 'B', content: '' });

    const result = await applyStructuredAction(db, {
      verb: 'Clear',
      targetType: 'note',
      targetId: noteA.id,
      targetIds: [noteA.id, noteB.id],
    });

    expect(result).toEqual({ status: 'applied' });
    expect(await listNotes(db, { sort: 'date-desc' })).toEqual([]);
  });

  it('Capture on a listItem with an existing parentListId adds the item to that list', async () => {
    const list = await createList(db, 'Покупки');

    const result = await applyStructuredAction(db, {
      verb: 'Capture',
      targetType: 'listItem',
      targetId: 'yn-server-item-1',
      parentListId: list.id,
      content: 'Молоко',
    });

    expect(result).toEqual({ status: 'applied' });
    const items = await listItemsForList(db, list.id);
    expect(items).toEqual([expect.objectContaining({ id: 'yn-server-item-1', text: 'Молоко' })]);
  });

  it('Capture on a listItem with listName set creates the list first, then the item, using the server ids for both', async () => {
    const result = await applyStructuredAction(db, {
      verb: 'Capture',
      targetType: 'listItem',
      targetId: 'yn-server-item-2',
      parentListId: 'yn-server-list-1',
      listName: 'Отпуск',
      content: 'Солнцезащитный крем',
    });

    expect(result).toEqual({ status: 'applied' });
    const items = await listItemsForList(db, 'yn-server-list-1');
    expect(items).toEqual([expect.objectContaining({ id: 'yn-server-item-2', text: 'Солнцезащитный крем' })]);
  });

  it('Modify on a listItem updates its text', async () => {
    const list = await createList(db, 'Покупки');
    const item = await addListItem(db, list.id, 'Молоко');

    const result = await applyStructuredAction(db, {
      verb: 'Modify',
      targetType: 'listItem',
      targetId: item.id,
      parentListId: list.id,
      content: 'Овсяное молоко',
    });

    expect(result).toEqual({ status: 'applied' });
    const items = await listItemsForList(db, list.id);
    expect(items).toEqual([expect.objectContaining({ id: item.id, text: 'Овсяное молоко' })]);
  });

  it('Complete on a listItem checks it off', async () => {
    const list = await createList(db, 'Покупки');
    const item = await addListItem(db, list.id, 'Молоко');

    const result = await applyStructuredAction(db, {
      verb: 'Complete',
      targetType: 'listItem',
      targetId: item.id,
      parentListId: list.id,
    });

    expect(result).toEqual({ status: 'applied' });
    const items = await listItemsForList(db, list.id);
    expect(items).toEqual([expect.objectContaining({ id: item.id, checked: true })]);
  });

  it('Remove on a listItem deletes it', async () => {
    const list = await createList(db, 'Покупки');
    const item = await addListItem(db, list.id, 'Молоко');

    const result = await applyStructuredAction(db, {
      verb: 'Remove',
      targetType: 'listItem',
      targetId: item.id,
      parentListId: list.id,
    });

    expect(result).toEqual({ status: 'applied' });
    expect(await listItemsForList(db, list.id)).toEqual([]);
  });

  it('Clear on listItems deletes every id in targetIds', async () => {
    const list = await createList(db, 'Покупки');
    const itemA = await addListItem(db, list.id, 'Молоко');
    const itemB = await addListItem(db, list.id, 'Хлеб');

    const result = await applyStructuredAction(db, {
      verb: 'Clear',
      targetType: 'listItem',
      targetId: itemA.id,
      targetIds: [itemA.id, itemB.id],
      parentListId: list.id,
    });

    expect(result).toEqual({ status: 'applied' });
    expect(await listItemsForList(db, list.id)).toEqual([]);
  });

  it('a Modify/Remove/Complete targeting an id that no longer exists locally is a no-op, reported as failed, not thrown', async () => {
    const result = await applyStructuredAction(db, {
      verb: 'Modify',
      targetType: 'note',
      targetId: 'does-not-exist',
      content: 'irrelevant',
    });

    expect(result).toEqual({ status: 'failed', reason: expect.stringContaining('does-not-exist') });
  });

  it('an unsupported targetType (list) is a no-op, reported as failed, not thrown', async () => {
    const result = await applyStructuredAction(db, {
      verb: 'Capture',
      targetType: 'list',
      targetId: 'yn-server-list-2',
      title: 'Заголовок',
    });

    expect(result.status).toBe('failed');
  });
});

describe('registerActionDispatcher', () => {
  let dir: string;
  let db: OpSqliteDb;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'yunote-dispatcher-register-test-'));
    db = await openMigratedDatabase({ name: 'test.sqlite', location: dir });
  });

  afterEach(() => {
    try {
      db?.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('applies an incoming structured-action message and acknowledges it', async () => {
    const transport = createInMemoryLocalTransport();
    registerActionDispatcher(db, transport);

    await transport.simulateReceive({
      transferId: 'transfer-1',
      kind: 'structured-action',
      small: { verb: 'Capture', targetType: 'note', targetId: 'yn-server-note-3', title: 'Идея', content: 'текст' },
    });

    expect(transport.acknowledgedIds).toEqual(['transfer-1']);
    const notes = await listNotes(db, { sort: 'date-desc' });
    expect(notes).toEqual([expect.objectContaining({ id: 'yn-server-note-3' })]);
  });

  it('ignores a message that is not kind: structured-action', async () => {
    const transport = createInMemoryLocalTransport();
    registerActionDispatcher(db, transport);

    await transport.simulateReceive({ transferId: 'transfer-2', kind: 'linked', small: {} });

    expect(transport.acknowledgedIds).toEqual([]);
  });

  it('still acknowledges a message whose action failed to apply (e.g. targets a missing entity) -- the message was received and handled, even though the action itself reports failure', async () => {
    const transport = createInMemoryLocalTransport();
    registerActionDispatcher(db, transport);

    await transport.simulateReceive({
      transferId: 'transfer-3',
      kind: 'structured-action',
      small: { verb: 'Remove', targetType: 'note', targetId: 'does-not-exist' },
    });

    expect(transport.acknowledgedIds).toEqual(['transfer-3']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest test/relay/actionDispatcher.test.ts`
Expected: FAIL — the module doesn't exist yet.

- [ ] **Step 3: Implement**

Create `src/relay/actionDispatcher.ts`:

```typescript
import type { OpSqliteDb } from '../db/connection';
import type { LocalTransport, LocalTransportMessage } from './localTransport';
import { createNote, updateNote, deleteNote } from '../data/notes';
import { createList, addListItem, updateListItem, deleteListItem } from '../data/lists';

export interface StructuredAction {
  verb: 'Capture' | 'Modify' | 'Remove' | 'Complete' | 'Clear';
  targetType: 'note' | 'list' | 'listItem';
  targetId: string;
  targetIds?: string[];
  parentListId?: string;
  listName?: string;
  title?: string;
  content?: string;
}

export type ActionDispatchResult = { status: 'applied' } | { status: 'failed'; reason: string };

export async function applyStructuredAction(db: OpSqliteDb, action: StructuredAction): Promise<ActionDispatchResult> {
  try {
    if (action.targetType === 'note') {
      if (action.verb === 'Capture') {
        await createNote(db, { id: action.targetId, title: action.title ?? '', content: action.content ?? '' });
        return { status: 'applied' };
      }
      if (action.verb === 'Modify') {
        await updateNote(db, action.targetId, { content: action.content ?? '' });
        return { status: 'applied' };
      }
      if (action.verb === 'Remove') {
        await deleteNote(db, action.targetId);
        return { status: 'applied' };
      }
      if (action.verb === 'Clear') {
        for (const id of action.targetIds ?? [action.targetId]) {
          await deleteNote(db, id);
        }
        return { status: 'applied' };
      }
    }

    if (action.targetType === 'listItem') {
      if (action.verb === 'Capture') {
        // listName present means the parent list doesn't exist locally
        // yet -- create it first, using the server-provided parentListId
        // as its id, exactly like the item itself uses targetId.
        if (action.listName !== undefined) {
          await createList(db, action.listName, { id: action.parentListId });
        }
        await addListItem(db, action.parentListId ?? '', action.content ?? '', { id: action.targetId });
        return { status: 'applied' };
      }
      if (action.verb === 'Modify') {
        await updateListItem(db, action.targetId, { text: action.content ?? '' });
        return { status: 'applied' };
      }
      if (action.verb === 'Complete') {
        await updateListItem(db, action.targetId, { checked: true });
        return { status: 'applied' };
      }
      if (action.verb === 'Remove') {
        await deleteListItem(db, action.targetId);
        return { status: 'applied' };
      }
      if (action.verb === 'Clear') {
        for (const id of action.targetIds ?? [action.targetId]) {
          await deleteListItem(db, id);
        }
        return { status: 'applied' };
      }
    }

    // targetType: 'list' (whole-list Capture/Modify/Remove) is never
    // actually produced by the shipped n8n graph today (confirmed while
    // planning this task) -- fails safely rather than pretending to
    // support it.
    return { status: 'failed', reason: `unsupported targetType/verb combination: ${action.targetType}/${action.verb}` };
  } catch (error) {
    // A repository function throws when it can't find the row it was asked
    // to update/delete (design spec §9: "Structured Action targets an id
    // that no longer exists locally... treats this as a no-op + logs, does
    // not crash"). Surfacing the real error message keeps this diagnosable
    // without needing a crash to see it.
    const message = error instanceof Error ? error.message : String(error);
    return { status: 'failed', reason: `${action.targetId}: ${message}` };
  }
}

export function registerActionDispatcher(db: OpSqliteDb, transport: LocalTransport): () => void {
  return transport.onReceive(async (message: LocalTransportMessage) => {
    if (message.kind !== 'structured-action') {
      return;
    }
    await applyStructuredAction(db, message.small as unknown as StructuredAction);
    // Acknowledged regardless of whether the action itself applied or
    // failed: the *message* was received and handled either way. A
    // permanently-failed action (target no longer exists) surfaces to
    // Key Fob as a sync-error via a separate mechanism (this plan's Task 5
    // does not build that reporting path yet -- see the plan's own
    // Self-Review Notes), not by leaving the message stuck retrying
    // forever.
    await transport.acknowledge(message.transferId);
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest test/relay/actionDispatcher.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npm test` — expected PASS, no regressions (baseline 61 after Tasks 1-3; adds 15 tests — 12 in `describe('applyStructuredAction')`, 3 in `describe('registerActionDispatcher')` — so expect 76).
Run: `npm run typecheck` — expected clean.

- [ ] **Step 6: Commit**

```bash
git add src/relay/actionDispatcher.ts test/relay/actionDispatcher.test.ts
git commit -m "feat: add ActionDispatcher, translating a StructuredAction into repository calls"
```

---

## Task 5: Sync outbox push + `linked`/`unlinked`/`sync-ack` handlers

**Files:**
- Create: `src/sync/outbox.ts`
- Test: `test/sync/outbox.test.ts`

**Interfaces:**
- Consumes: Task 1's `sync_outbox` table; Task 3's `LocalTransport`.
- Produces:
  ```typescript
  export interface SyncPushEntity {
    entityType: 'note' | 'list' | 'listItem';
    id: string;
    deleted: boolean;
    data?: Record<string, unknown>; // present only when deleted is false
  }

  // Reads every row currently in sync_outbox with transfer_id IS NULL,
  // builds one sync-push message carrying all of them, sends it, and
  // stamps each included row with the message's transferId so a retry
  // (before ack) doesn't double-queue it into a second push.
  export async function flushOutbox(db: OpSqliteDb, transport: LocalTransport): Promise<void>;

  // Registers handlers for the 3 message kinds this repo's side of the
  // protocol needs to react to (design spec §4/§5.6):
  // - 'linked': marks every existing note/list/list_item dirty (fresh
  //   entities that predate this pairing still need their first push).
  // - 'unlinked': clears sync_outbox entirely (nothing left to sync
  //   against a link that no longer exists) -- does NOT touch notes/
  //   lists/list_items themselves (unlinking is not a data-loss event).
  // - 'sync-ack': clears the sync_outbox rows named in the ack payload.
  export function registerSyncHandlers(db: OpSqliteDb, transport: LocalTransport): () => void;
  ```

- [ ] **Step 1: Write the failing tests**

Create `test/sync/outbox.test.ts`:

```typescript
import { openMigratedDatabase, type OpSqliteDb } from '../../src/db/connection';
import { flushOutbox, registerSyncHandlers } from '../../src/sync/outbox';
import { createInMemoryLocalTransport } from '../../src/relay/inMemoryLocalTransport';
import { createNote, deleteNote } from '../../src/data/notes';
import { createList, addListItem } from '../../src/data/lists';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('flushOutbox', () => {
  let dir: string;
  let db: OpSqliteDb;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'yunote-outbox-test-'));
    db = await openMigratedDatabase({ name: 'test.sqlite', location: dir });
  });

  afterEach(() => {
    try {
      db?.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sends one sync-push message carrying every dirty entity', async () => {
    const note = await createNote(db, { title: 'Идея', content: 'текст' });
    const list = await createList(db, 'Покупки');
    const transport = createInMemoryLocalTransport();

    await flushOutbox(db, transport);

    expect(transport.sentMessages).toHaveLength(1);
    const [message] = transport.sentMessages;
    expect(message.kind).toBe('sync-push');
    const entities = (message.small?.entities ?? []) as { entityType: string; id: string }[];
    expect(entities.map((e) => e.id).sort()).toEqual([list.id, note.id].sort());
  });

  it('a deleted entity is sent as a tombstone (deleted: true, no data)', async () => {
    const note = await createNote(db, { title: 'Идея', content: 'текст' });
    await deleteNote(db, note.id);
    const transport = createInMemoryLocalTransport();

    await flushOutbox(db, transport);

    const [message] = transport.sentMessages;
    const entities = (message.small?.entities ?? []) as { id: string; deleted: boolean; data?: unknown }[];
    expect(entities).toEqual([{ entityType: 'note', id: note.id, deleted: true }]);
  });

  it('does nothing (sends no message) when sync_outbox is empty', async () => {
    const transport = createInMemoryLocalTransport();

    await flushOutbox(db, transport);

    expect(transport.sentMessages).toEqual([]);
  });

  it('a row already stamped with a transfer_id (already sent, awaiting ack) is not sent again', async () => {
    await createNote(db, { title: 'Идея', content: 'текст' });
    const transport = createInMemoryLocalTransport();
    await flushOutbox(db, transport);
    expect(transport.sentMessages).toHaveLength(1);

    await flushOutbox(db, transport);

    expect(transport.sentMessages).toHaveLength(1);
  });

  it('a new dirty entity created after a flush is included in the next flush', async () => {
    const transport = createInMemoryLocalTransport();
    await createNote(db, { title: 'A', content: '' });
    await flushOutbox(db, transport);

    const secondNote = await createNote(db, { title: 'B', content: '' });
    await flushOutbox(db, transport);

    expect(transport.sentMessages).toHaveLength(2);
    const secondEntities = (transport.sentMessages[1].small?.entities ?? []) as { id: string }[];
    expect(secondEntities.map((e) => e.id)).toEqual([secondNote.id]);
  });
});

describe('registerSyncHandlers', () => {
  let dir: string;
  let db: OpSqliteDb;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'yunote-sync-handlers-test-'));
    db = await openMigratedDatabase({ name: 'test.sqlite', location: dir });
  });

  afterEach(() => {
    try {
      db?.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('linked marks every existing note/list/list_item dirty', async () => {
    // Simulate pre-existing local data that predates pairing: clear the
    // outbox entries createNote/createList/addListItem already wrote, so
    // this test genuinely proves 'linked' re-marks them, not that they
    // were already dirty from creation.
    const note = await createNote(db, { title: 'Идея', content: 'текст' });
    const list = await createList(db, 'Покупки');
    const item = await addListItem(db, list.id, 'Молоко');
    await db.execute('DELETE FROM sync_outbox');

    const transport = createInMemoryLocalTransport();
    registerSyncHandlers(db, transport);
    await transport.simulateReceive({ transferId: 't-linked', kind: 'linked', small: { linkedAt: '2026-09-09T00:00:00.000Z' } });

    const { rows } = await db.execute('SELECT entity_id FROM sync_outbox ORDER BY entity_id');
    expect(rows?.map((r) => r.entity_id).sort()).toEqual([item.id, list.id, note.id].sort());
  });

  it('unlinked clears sync_outbox but leaves notes/lists/list_items untouched', async () => {
    const note = await createNote(db, { title: 'Идея', content: 'текст' });
    const transport = createInMemoryLocalTransport();
    registerSyncHandlers(db, transport);

    await transport.simulateReceive({ transferId: 't-unlinked', kind: 'unlinked', small: {} });

    const { rows: outboxRows } = await db.execute('SELECT * FROM sync_outbox');
    expect(outboxRows).toEqual([]);
    const { rows: noteRows } = await db.execute('SELECT id FROM notes WHERE id = ?', [note.id]);
    expect(noteRows).toHaveLength(1);
  });

  it('sync-ack clears exactly the outbox rows named in its payload, leaving others untouched', async () => {
    const noteA = await createNote(db, { title: 'A', content: '' });
    const noteB = await createNote(db, { title: 'B', content: '' });
    const transport = createInMemoryLocalTransport();
    registerSyncHandlers(db, transport);

    await transport.simulateReceive({
      transferId: 't-ack',
      kind: 'sync-ack',
      small: { acknowledged: [{ entityType: 'note', id: noteA.id }] },
    });

    const { rows } = await db.execute('SELECT entity_id FROM sync_outbox');
    expect(rows?.map((r) => r.entity_id)).toEqual([noteB.id]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest test/sync/outbox.test.ts`
Expected: FAIL — the module doesn't exist yet.

- [ ] **Step 3: Implement**

Create `src/sync/outbox.ts`:

```typescript
import type { OpSqliteDb } from '../db/connection';
import type { LocalTransport, LocalTransportMessage } from '../relay/localTransport';
import { generateId } from '../data/id';

interface OutboxRow {
  entity_type: 'note' | 'list' | 'listItem';
  entity_id: string;
  deleted: number;
  transfer_id: string | null;
}

async function loadEntityData(
  db: OpSqliteDb,
  entityType: 'note' | 'list' | 'listItem',
  id: string,
): Promise<Record<string, unknown> | undefined> {
  const table = { note: 'notes', list: 'lists', listItem: 'list_items' }[entityType];
  const { rows } = await db.execute(`SELECT * FROM ${table} WHERE id = ?`, [id]);
  return (rows?.[0] as Record<string, unknown> | undefined) ?? undefined;
}

export async function flushOutbox(db: OpSqliteDb, transport: LocalTransport): Promise<void> {
  const { rows } = await db.execute('SELECT * FROM sync_outbox WHERE transfer_id IS NULL');
  const dirty = (rows ?? []) as unknown as OutboxRow[];
  if (dirty.length === 0) {
    return;
  }

  const entities = await Promise.all(
    dirty.map(async (row) => {
      if (row.deleted === 1) {
        return { entityType: row.entity_type, id: row.entity_id, deleted: true };
      }
      const data = await loadEntityData(db, row.entity_type, row.entity_id);
      return { entityType: row.entity_type, id: row.entity_id, deleted: false, data };
    }),
  );

  const transferId = generateId();
  await transport.send({ transferId, kind: 'sync-push', small: { entities } });

  for (const row of dirty) {
    await db.execute('UPDATE sync_outbox SET transfer_id = ? WHERE entity_type = ? AND entity_id = ?', [
      transferId,
      row.entity_type,
      row.entity_id,
    ]);
  }
}

export function registerSyncHandlers(db: OpSqliteDb, transport: LocalTransport): () => void {
  return transport.onReceive(async (message: LocalTransportMessage) => {
    if (message.kind === 'linked') {
      for (const [entityType, table] of [
        ['note', 'notes'],
        ['list', 'lists'],
        ['listItem', 'list_items'],
      ] as const) {
        const { rows } = await db.execute(`SELECT id FROM ${table}`);
        for (const row of (rows ?? []) as { id: string }[]) {
          await db.execute(
            `INSERT INTO sync_outbox (entity_type, entity_id, deleted, transfer_id, created_at)
             VALUES (?, ?, 0, NULL, ?)
             ON CONFLICT (entity_type, entity_id) DO UPDATE SET transfer_id = NULL`,
            [entityType, row.id, new Date().toISOString()],
          );
        }
      }
      await transport.acknowledge(message.transferId);
      return;
    }

    if (message.kind === 'unlinked') {
      await db.execute('DELETE FROM sync_outbox');
      await transport.acknowledge(message.transferId);
      return;
    }

    if (message.kind === 'sync-ack') {
      const acknowledged = (message.small?.acknowledged ?? []) as { entityType: string; id: string }[];
      for (const entry of acknowledged) {
        await db.execute('DELETE FROM sync_outbox WHERE entity_type = ? AND entity_id = ?', [
          entry.entityType,
          entry.id,
        ]);
      }
      await transport.acknowledge(message.transferId);
      return;
    }
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest test/sync/outbox.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npm test` — expected PASS, no regressions (baseline 76 after Tasks 1-4; adds 8 tests — 5 in `describe('flushOutbox')`, 3 in `describe('registerSyncHandlers')` — so expect 84).
Run: `npm run typecheck` — expected clean.

- [ ] **Step 6: Commit**

```bash
git add src/sync/outbox.ts test/sync/outbox.test.ts
git commit -m "feat: add sync outbox push and linked/unlinked/sync-ack handlers"
```

---

## Task 6: Android native shell scaffolding

**This task is not TDD'd** — there is no meaningful unit test for "does a native Android project exist and build." Verification is a real Gradle build, matching how `mobile-app` (the sibling repo) already has a working `android/` directory at the identical React Native version (`0.86.0`) — reuse that as the structural reference, not a blind CLI init.

**Files:**
- Create: `android/` (an entire native Android project directory tree)
- Modify: `package.json` (add `android`/`start` scripts, matching `mobile-app`'s own)

**Interfaces:**
- Produces: a buildable Android shell — package id `com.yunote.app` (no prior decision existed for this; chosen to mirror `mobile-app`'s own `com.iotkeyfobplatform.app` convention — trivially renamable later if the human partner wants something different before any real release).

- [ ] **Step 1: Generate a throwaway reference project**

In a scratch directory (not inside this repo), run:

```bash
npx @react-native-community/cli@latest init YunoteScaffoldTemp --version 0.86.0 --skip-install --package-name com.yunote.app
```

This produces a complete `android/` (and `ios/`, which this task ignores) directory tree at the exact React Native version this repo already depends on.

- [ ] **Step 2: Copy the generated `android/` directory into this repo**

Copy `YunoteScaffoldTemp/android/` to this repo's root as `android/`. Do not copy `ios/`, `App.tsx`, `index.js`, or any other generated file — this repo already has its own `src/`, and no root-level entry point or `index.js` exists yet because there are no UI screens to render (Step 5's job); adding a placeholder entry point now would be exactly the kind of "add appropriate handling for a case that doesn't exist yet" this project's own engineering standard forbids. If Gradle's build fails without an `index.js`, add the minimal one Metro's bundler actually requires to resolve (a bare `AppRegistry.registerComponent` call rendering nothing, e.g. `<View />`) — but only if the build step in Step 4 actually demands it; don't add it speculatively.

- [ ] **Step 3: Reconcile the copied Gradle files against `mobile-app`'s working ones**

Diff `android/build.gradle`, `android/app/build.gradle`, `android/gradle.properties`, and `android/settings.gradle` against the equivalent files in `../IoT-Key-Fob-Project/mobile-app/android/`. Both projects are pinned to the same React Native version, so the two should be nearly identical apart from the package/app name — if a Gradle/AGP/NDK version differs, prefer whichever `mobile-app` already has (it's a proven-working configuration on this exact machine), since matching a working sibling reduces the chance of hitting an environment-specific build issue neither project has actually exercised yet.

- [ ] **Step 4: Verify the build**

```bash
cd android && ./gradlew assembleDebug
```

Expected: `BUILD SUCCESSFUL`. This does not require an emulator or device — it's a pure compile/package check. If it fails, diagnose using `superpowers:systematic-debugging` rather than guessing; do not proceed to Step 5 with a broken build.

- [ ] **Step 5: Add the convenience npm scripts**

In `package.json`, add (matching `mobile-app`'s own `package.json` script names for consistency):

```json
"android": "react-native run-android",
"start": "react-native start"
```

This also requires `react-native` and `@react-native-community/cli` as `devDependencies` if the generated project's own `package.json` (from Step 1) declares different versions than what's already in `package.json` — reconcile by hand, don't blindly overwrite this repo's existing `dependencies` block.

- [ ] **Step 6: Clean up the scratch directory**

Delete `YunoteScaffoldTemp` (outside this repo — nothing to commit).

- [ ] **Step 7: Run the full suite and typecheck one more time**

Run: `npm test` — expected PASS, unaffected by this task (a native directory addition doesn't touch any TypeScript this suite exercises).
Run: `npm run typecheck` — expected clean.

- [ ] **Step 8: Commit**

```bash
git add android/ package.json package-lock.json
git commit -m "feat: add bare Android native shell (com.yunote.app)"
```

---

## Self-Review Notes

- **Spec coverage:** §3.4 (LocalTransport port) → Task 3. §5.1/§5.3 (rev semantics) → Tasks 1-2. §5.4 (single-writer principle) → honored throughout Task 2 and Task 4 (ActionDispatcher calls the same repository functions, never a second write path) and stated explicitly in Task 4's own header. §5.6 (sync_outbox, linked/unlinked/sync-ack) → Tasks 1 and 5. §8 (yuNote-side components: native shell, ActionDispatcher, sync outbox) → Tasks 1-6, explicitly minus the real platform transport adapters (out of scope, stated in Architecture). §13 item 3 → this plan's whole scope.
- **Placeholder scan:** every task has concrete, complete code and concrete test assertions. The one deliberately open judgment call is Task 6 Step 2's "add `index.js` only if the build actually demands it" — this is not a placeholder, it's an explicit instruction not to speculatively build something the build step itself will prove is or isn't needed.
- **Type consistency:** `Note`/`List`/`ListItem` all gain `rev: number` in Task 2 and stay consistent everywhere they're read afterward (Task 4's tests, Task 5's `loadEntityData`). `StructuredAction`'s field names in Task 4 are copied verbatim from the already-shipped `cloud-platform` contract (`targetIds`, `listName`, `title`, `content`, `parentListId`) — cross-checked against that repo's `cloud-platform/src/contract/workflowResult.ts` while writing this plan, not assumed from memory.
- **Cross-task dependencies:** Task 2 must land before Task 4 (ActionDispatcher needs the explicit-id-capable `create*` functions) and before Task 5 (outbox needs `rev`/dirty-marking to have anything to read). Task 3 is independent of Tasks 1-2 and could run in either order relative to them; kept after them in dispatch order only because Task 4/5 need both. Task 6 is fully independent of Tasks 1-5 and could run first, last, or in parallel with a different session — kept last here only because it's the one task this plan can't fully verify without a real build step, and it's better to have the logic layer's own tests green first as a baseline.
- **A real design gap found while planning, not in the spec:** the spec's §5.4 states the single-writer principle but doesn't spell out that `createNote`/`createList`/`addListItem` need to accept a caller-supplied id — reading the actual shipped code (`src/data/notes.ts`/`lists.ts`) showed they always mint their own via `generateId()`, which would silently break every `Capture` Structured Action (the local row would get a different id than the one the cloud replica is tracking). Confirmed with the human partner this is real scope for this plan, not a Step 2 oversight to go back and fix there (Step 2 never touched this repo).
- **Two scope boundaries confirmed with the human partner before this plan was written:** (1) real platform transport adapters (Android Intent-extras/FileProvider, any iOS work) are out of scope — this plan builds only the port and its in-memory double; (2) iOS native scaffolding is out of scope entirely — this machine has no Xcode. Task 6 covers Android only.
