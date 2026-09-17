# yuNote Classes Sync-Boundary Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop yuNote's Class data — the `classes` table, the fact that a class mutation happened at all, and the snapshot/enrollment path found while planning this — from ever reaching `cloud-platform`, structurally rather than by filtering, without breaking the existing note/list sync journal protocol or device enrollment.

**Architecture:** Two client-side fixes in `src/data/localOperation.ts` — one that keeps class events out of `mutation_journal` for operations that also touch real synced entities (dense re-sequencing, no protocol change), and one that keeps purely-local class operations off the sync-revision machinery entirely (`runLocalOnlyTransaction`). A product-rule guard (class can't be deleted while it has members) makes `deleteClass`'s shape unconditionally pure so it can use the same path as `createClass`/`renameClass`. Server-side, `cloud-platform` stops accepting or storing `entityType:'class'` at all, and a migration drops the now-pointless `yunote_classes` table and its dangling FK from the two organization tables. A second, independent sync surface found while planning — the full-account snapshot used during device enrollment — gets the same treatment on both sides (Tasks 7-9), since it's the same principle (classes never reach another device) applied to a different mechanism, and dropping the table without fixing it first would break enrollment and account deletion immediately.

**Tech Stack:** TypeScript, `op-sqlite` (yuNote client), `better-sqlite3` (cloud-platform server), Jest (both repos).

**Spec:** `docs/superpowers/specs/2026-09-17-yunote-classes-sync-boundary-fix-design.md` (this repo — see its §8 for the snapshot/enrollment surface, added after the spec's initial approval), with a small addendum in `docs/superpowers/specs/2026-09-17-yunote-classes-interaction-design.md` §13 (the `deleteClass` product rule). Read both before starting.

## Global Constraints

- Class events must never appear in `mutation_journal`, in any shape (spec §3).
- Journaled `sequence` values must stay densely `0..N-1` per revision — the server rejects gaps (spec §2).
- `runLocalOnlyTransaction` must not become a second journal system — no `operationId`, no idempotency ledger, no events array (spec §3.2).
- The server must reject an unexpected `entityType:'class'` explicitly (a clear validation error), never silently drop it (spec §4).
- Classes must never appear in the enrollment snapshot either, on either side of the hash comparison (spec §8).
- Client changes ship before server changes — no production installed base requiring staged rollout (spec §6).
- This plan does **not** touch the Classes interaction/UI work (`2026-09-17-yunote-classes-interaction-design.md`) — that plan doesn't exist yet and isn't a dependency of this one.
- This plan does **not** build a multi-device snapshot-restore feature — nothing client-side downloads and applies a snapshot yet (spec §8); Tasks 7/9 only keep the schema consistent with where that feature would need to end up.

Tasks 1-3 and Task 9 are in the **yuNote** repo (`C:\Users\johny\Desktop\cod\yuNote`). Tasks 4-8 are in the **cloud-platform** repo (`C:\Users\johny\Desktop\cod\IoT-Key-Fob-Project\cloud-platform`). All file paths below are relative to the task's own repo root.

**Execution order is not the task numbering** — Task 6 (drop `yunote_classes`) must not land before Task 7 (stop querying it from `readSnapshot`) or Task 8 (stop purging it from `deleteAllForUser`), both of which `db.prepare` a statement against that table at construction time and would throw immediately once it's gone. Correct order: **1 → 2 → 3 → 4 → 5 → 7 → 8 → 6 → 9** (Task 9 is the client-side half of Task 7 and can ship any time at or after Task 7 — they're grouped adjacently here for clarity, not because 9 blocks anything downstream of it). Tasks are numbered in the order they were designed, not the order they're safe to execute in — each task's own text repeats its actual dependency, so this note is a summary, not the only place it's stated.

---

## Task 1: Stop journaling class events in mixed operations

**Files:**
- Modify: `src/data/localOperation.ts:74-86`
- Test: `test/data/localOperation.test.ts`

**Interfaces:**
- Consumes: nothing new — `JournalEvent` (already defined in this file) gains no new fields.
- Produces: `runLocalOperation`'s existing public signature is unchanged. Internal behavior change only: events with `entityType==='class'` are never inserted into `mutation_journal`, and the `sequence` column for whatever *is* inserted is dense (`0..N-1`) regardless of where in the original events array the class event fell.

- [ ] **Step 1: Write the failing tests**

Add to `test/data/localOperation.test.ts`, inside the existing `describe('runLocalOperation', ...)` block (after the existing tests, same file, same imports already present):

```ts
  it('never journals a class event, even when mixed with a journaled event', async () => {
    const db=await openMigratedDatabase({ name:'test.sqlite', location:dir });
    try {
      await runLocalOperation(db,{ operationId:'op-mixed', request:{}, execute:async()=>({
        result:{ status:'applied' }, events:[
          { entityType:'class', entityId:'c1', mutation:'upsert', payload:{ id:'c1', name:'Работа' } },
          { entityType:'note', entityId:'n1', mutation:'upsert', payload:{ id:'n1', title:'Идея' } },
        ],
      })});
      const rows=(await db.execute('SELECT sequence,entity_type,entity_id FROM mutation_journal ORDER BY sequence')).rows;
      expect(rows).toEqual([{ sequence:0, entity_type:'note', entity_id:'n1' }]);
    } finally { db.close(); }
  });

  it('keeps journal sequence dense when a class event is interleaved between journaled events', async () => {
    const db=await openMigratedDatabase({ name:'test.sqlite', location:dir });
    try {
      await runLocalOperation(db,{ operationId:'op-interleaved', request:{}, execute:async()=>({
        result:{ status:'applied' }, events:[
          { entityType:'note', entityId:'n1', mutation:'upsert', payload:{ id:'n1', title:'Первая' } },
          { entityType:'class', entityId:'c1', mutation:'upsert', payload:{ id:'c1', name:'Работа' } },
          { entityType:'note', entityId:'n2', mutation:'upsert', payload:{ id:'n2', title:'Вторая' } },
        ],
      })});
      const rows=(await db.execute('SELECT sequence,entity_type,entity_id FROM mutation_journal ORDER BY sequence')).rows;
      expect(rows).toEqual([
        { sequence:0, entity_type:'note', entity_id:'n1' },
        { sequence:1, entity_type:'note', entity_id:'n2' },
      ]);
    } finally { db.close(); }
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest test/data/localOperation.test.ts -t "never journals a class event"` and `npx jest test/data/localOperation.test.ts -t "keeps journal sequence dense"`
Expected: both FAIL — today's code journals the `class` event too, so the first test finds 2 rows instead of 1, and the second finds `sequence` values `0,1,2` instead of `0,1`.

- [ ] **Step 3: Fix the event-insertion loop**

In `src/data/localOperation.ts`, replace the `for` loop currently at lines 74-86 (inside `runLocalOperation`, right before `await tx.execute('UPDATE dataset_state ...')`):

```ts
    let journalSequence=0;
    for (let index=0;index<executed.events.length;index++) {
      const event=executed.events[index];
      if (event.entityId.trim().length===0) throw new Error('journal entityId must not be empty');
      if (event.mutation==='upsert' && event.payload===undefined) throw new Error('journal upsert requires payload');
      if (event.mutation==='delete' && event.payload!==undefined) throw new Error('journal delete must not contain payload');
      if (event.entityType==='class') continue; // Classes are outside the synchronized dataset boundary -- never written to mutation_journal, regardless of what else the same local operation touched.
      await tx.execute(
        `INSERT INTO mutation_journal
         (dataset_revision,sequence,operation_id,entity_type,entity_id,mutation,payload_json,created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        [revision,journalSequence,input.operationId,event.entityType,event.entityId,event.mutation,
          event.payload===undefined ? null : canonicalJson(event.payload,`events[${index}].payload`),createdAt],
      );
      journalSequence++;
    }
```

- [ ] **Step 4: Run all localOperation tests to verify they pass**

Run: `npx jest test/data/localOperation.test.ts`
Expected: PASS — all 6 tests (4 existing + 2 new), including the existing `[note, listItem]` ordering test, which must still show `sequence:0,1` (that case has no class event, so the dense counter and the old index-based counter produce identical output).

- [ ] **Step 5: Commit**

```bash
git add src/data/localOperation.ts test/data/localOperation.test.ts
git commit -m "fix(sync): never journal class events, keep journaled sequence dense

Class mutations must never reach mutation_journal -- classes are
outside the synchronized dataset boundary. Mixed operations that also
touch a real synced entity keep working unchanged: the journaled
sequence now reflects journaled order, not the original event array's
index, so the server's contiguous-sequence check still passes.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 2: Add `runLocalOnlyTransaction`

**Files:**
- Modify: `src/data/localOperation.ts` (append after `runLocalOperation`)
- Test: `test/data/localOperation.test.ts`

**Interfaces:**
- Produces: `runLocalOnlyTransaction<T>(db: OpSqliteDb, execute: (tx: OpSqliteExecutor) => Promise<T>): Promise<T>` — Task 3 consumes this exact signature.

- [ ] **Step 1: Write the failing test**

Add to `test/data/localOperation.test.ts`. First, add `runLocalOnlyTransaction` to the existing import on line 2:

```ts
import { runLocalOperation, runLocalOnlyTransaction, OperationPayloadMismatchError } from '../../src/data/localOperation';
```

Then add a new top-level `describe` block, after the existing `describe('runLocalOperation', ...)` block closes:

```ts
describe('runLocalOnlyTransaction', () => {
  let dir:string;
  beforeEach(() => { dir=mkdtempSync(join(tmpdir(),'yunote-local-only-')); });
  afterEach(() => rmSync(dir,{ recursive:true, force:true }));

  it('commits its own writes and returns the callback result, without touching sync bookkeeping', async () => {
    const db=await openMigratedDatabase({ name:'test.sqlite', location:dir });
    try {
      const result=await runLocalOnlyTransaction(db, async(tx)=>{
        await tx.execute("INSERT INTO classes (id,name,created_at,updated_at,rev,position) VALUES ('c1','Работа','t','t',1,0)");
        return { id:'c1' };
      });
      expect(result).toEqual({ id:'c1' });
      expect((await db.execute('SELECT id,name FROM classes')).rows).toEqual([{ id:'c1', name:'Работа' }]);
      expect((await db.execute('SELECT revision FROM dataset_state')).rows).toEqual([{ revision:0 }]);
      expect((await db.execute('SELECT * FROM mutation_journal')).rows).toEqual([]);
      expect((await db.execute('SELECT * FROM applied_operations')).rows).toEqual([]);
    } finally { db.close(); }
  });

  it('rolls back its writes if the callback throws', async () => {
    const db=await openMigratedDatabase({ name:'test.sqlite', location:dir });
    try {
      await expect(runLocalOnlyTransaction(db, async(tx)=>{
        await tx.execute("INSERT INTO classes (id,name,created_at,updated_at,rev,position) VALUES ('c1','Работа','t','t',1,0)");
        throw new Error('simulated crash');
      })).rejects.toThrow('simulated crash');
      expect((await db.execute('SELECT * FROM classes')).rows).toEqual([]);
    } finally { db.close(); }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/data/localOperation.test.ts -t "runLocalOnlyTransaction"`
Expected: FAIL with a TypeScript/module error — `runLocalOnlyTransaction` is not exported yet.

- [ ] **Step 3: Add the helper**

Append to `src/data/localOperation.ts`, after the closing brace of `runLocalOperation`:

```ts
// Deliberately not a second journal system: no operationId, no idempotency
// ledger, no events array. Its only job is to name a transaction as
// local-only at the call site -- for mutations that are outside the
// synchronized dataset boundary and must never touch dataset_state,
// mutation_journal, or applied_operations at all.
export async function runLocalOnlyTransaction<T>(
  db:OpSqliteDb,
  execute:(tx:OpSqliteExecutor)=>Promise<T>,
):Promise<T> {
  let result:T|undefined;
  await db.transaction(async(tx)=>{
    result=await execute(tx);
  });
  return result as T;
}
```

`OpSqliteDb` is already imported at the top of this file (line 1); no new import needed.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest test/data/localOperation.test.ts`
Expected: PASS — all 8 tests (6 from Task 1 + 2 new).

- [ ] **Step 5: Commit**

```bash
git add src/data/localOperation.ts test/data/localOperation.test.ts
git commit -m "feat(sync): add runLocalOnlyTransaction for local-only mutations

Classes.ts's pure class-only operations need a transaction boundary
that never touches dataset_state/mutation_journal/applied_operations --
this is that boundary, explicit at each call site, not a second
journal mechanism.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 3: Guard `deleteClass`, migrate class-only operations, add `renameClass`

**Files:**
- Modify: `src/data/classes.ts`
- Test: `test/data/classes.test.ts`
- Test: `test/data/repositoryJournal.test.ts`

**Interfaces:**
- Consumes: `runLocalOnlyTransaction` from Task 2.
- Produces: `renameClass(db: OpSqliteDb, id: string, name: string): Promise<Class>` (new — the interaction-model plan's future rename-in-place UI task will call this directly). `createClass`/`deleteClass` keep their existing signatures; `deleteClassInTransaction`'s signature changes from `Promise<JournalEvent[]>` to `Promise<void>` (confirmed via `grep` to have no callers outside this file).

**Found during Task 1's review, not in this task's original scope:** `test/data/repositoryJournal.test.ts` (a third test file touching class journaling, missed by this plan's original file survey) has two tests whose expectations this task invalidates twice over — once because `createClass`/`deleteClass` stop consuming `dataset_state.revision` at all, and again because `deleteClass` now rejects a non-empty class outright rather than reflowing its members, which is exactly what one of the two tests' scenario does. Step 4 below rewrites both — this is not optional cleanup, the suite does not pass without it.

- [ ] **Step 1: Write the failing tests**

Replace the existing `it('deleteClass removes the class but does not delete its notes -- their class_id becomes NULL', ...)` test in `test/data/classes.test.ts` (lines 41-56) with:

```ts
  it('deleteClass rejects deleting a class that still has a member note', async () => {
    const cls = await createClass(db, 'Работа');
    await db.execute(
      'INSERT INTO notes (id, title, content, class_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['note-1', 'Идея', 'текст', cls.id, '2026-09-07T00:00:00.000Z', '2026-09-07T00:00:00.000Z'],
    );

    await expect(deleteClass(db, cls.id)).rejects.toThrow(/member notes/);

    expect(await listClasses(db)).toEqual([cls]);
  });

  it('deleteClass rejects deleting a class that still has a member list', async () => {
    const cls = await createClass(db, 'Работа');
    await db.execute(
      'INSERT INTO lists (id, title, class_id, position, purpose, sharing_mode, rev, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, 1, ?, ?)',
      ['list-1', 'Покупки', cls.id, 'generic', 'personal', '2026-09-07T00:00:00.000Z', '2026-09-07T00:00:00.000Z'],
    );

    await expect(deleteClass(db, cls.id)).rejects.toThrow(/member lists/);

    expect(await listClasses(db)).toEqual([cls]);
  });

  it('deleteClass succeeds once the class has no member notes or lists', async () => {
    const cls = await createClass(db, 'Пустой класс');

    await deleteClass(db, cls.id);

    expect(await listClasses(db)).toEqual([]);
  });
```

Add a new test to the same file's `describe` block, for the sync-boundary behavior itself:

```ts
  it('createClass, deleteClass, and renameClass never touch dataset_state.revision or mutation_journal', async () => {
    const cls = await createClass(db, 'Работа');
    const renamed = await renameClass(db, cls.id, 'Проекты');
    await deleteClass(db, renamed.id);

    expect((await db.execute('SELECT revision FROM dataset_state')).rows).toEqual([{ revision:0 }]);
    expect((await db.execute('SELECT * FROM mutation_journal')).rows).toEqual([]);
  });

  it('renameClass updates the name and bumps rev', async () => {
    const cls = await createClass(db, 'Работа');

    const renamed = await renameClass(db, cls.id, 'Проекты');

    expect(renamed.name).toBe('Проекты');
    expect(renamed.rev).toBe(cls.rev + 1);
    expect(await listClasses(db)).toEqual([renamed]);
  });
```

Update the import line at the top of the file to include `renameClass`:

```ts
import { createClass, deleteClass, renameClass, listClasses } from '../../src/data/classes';
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest test/data/classes.test.ts`
Expected: FAIL — `renameClass` doesn't exist yet (import error), and the old delete-with-reflow test this replaces no longer exists to conflict, but the new guard tests fail against today's reflow-on-delete behavior.

- [ ] **Step 3: Rewrite `src/data/classes.ts`**

Replace `deleteClassInTransaction` (lines 46-63) with a version that guards instead of reflowing:

```ts
export async function deleteClassInTransaction(tx:OpSqliteExecutor,id:string):Promise<void> {
  const { rows:classRows }=await tx.execute('SELECT id FROM classes WHERE id=?',[id]);
  if (!classRows?.length) throw new Error(`Class not found: ${id}`);
  const { rows:noteRows }=await tx.execute('SELECT id FROM notes WHERE class_id=? LIMIT 1',[id]);
  if (noteRows?.length) throw new Error(`Cannot delete class ${id}: it still has member notes`);
  const { rows:listRows }=await tx.execute('SELECT id FROM lists WHERE class_id=? LIMIT 1',[id]);
  if (listRows?.length) throw new Error(`Cannot delete class ${id}: it still has member lists`);
  await tx.execute('DELETE FROM classes WHERE id=?',[id]);
}
```

Replace `createClass` and `deleteClass` (lines 37-44 and the old lines 65-69) to use `runLocalOnlyTransaction` instead of `runLocalOperation`, and add `renameClassInTransaction`/`renameClass`:

```ts
export async function createClass(db: OpSqliteDb, name: string): Promise<Class> {
  const id = generateId();
  return runLocalOnlyTransaction(db, async (tx) => {
    const created = await createClassInTransaction(tx, { id, name });
    return created.klass;
  });
}

export async function renameClassInTransaction(tx:OpSqliteExecutor,id:string,name:string):Promise<Class> {
  const { rows }=await tx.execute('SELECT * FROM classes WHERE id=?',[id]);
  if (!rows?.[0]) throw new Error(`Class not found: ${id}`);
  const existing=toClass(rows[0] as unknown as ClassRow);
  const klass:Class={ ...existing,name,rev:existing.rev+1,updatedAt:nowIso() };
  await tx.execute('UPDATE classes SET name=?,rev=?,updated_at=? WHERE id=?',[klass.name,klass.rev,klass.updatedAt,id]);
  return klass;
}

export async function renameClass(db: OpSqliteDb, id: string, name: string): Promise<Class> {
  return runLocalOnlyTransaction(db, (tx) => renameClassInTransaction(tx, id, name));
}

export async function deleteClass(db: OpSqliteDb, id: string): Promise<void> {
  await runLocalOnlyTransaction(db, async (tx) => {
    await deleteClassInTransaction(tx, id);
  });
}
```

`createClassInTransaction` itself is unchanged — it still returns `{ klass, events }`, since the interaction-model plan's future `createClassFromNotes` (a real mixed operation, via `runLocalOperation`) needs that `events` array; `createClass` here just discards it.

Replace the top-of-file imports (currently):

```ts
import type { OpSqliteDb, OpSqliteExecutor } from '../db/connection';
import { generateId, nowIso } from './id';
import { runLocalOperation, type JournalEvent } from './localOperation';
import { updateNoteInTransaction } from './notes';
import { updateListInTransaction } from './lists';
```

with:

```ts
import type { OpSqliteDb, OpSqliteExecutor } from '../db/connection';
import { generateId, nowIso } from './id';
import { runLocalOnlyTransaction, type JournalEvent } from './localOperation';
```

`updateNoteInTransaction`/`updateListInTransaction` were only used by the old reflow loop this task removes — confirmed by this task's own rewrite, not left to a follow-up check. `runLocalOperation` is no longer called anywhere in this file (`createClass`/`deleteClass`/`renameClass` all move to `runLocalOnlyTransaction`), so its import is replaced rather than added-to. `JournalEvent` stays — `createClassInTransaction` still returns one.

- [ ] **Step 4: Rewrite `test/data/repositoryJournal.test.ts`'s two class-touching tests**

Replace the file's first test (currently `'journals class creation and class deletion with every affected note in one revision'`, lines 14-41) — its `deleteClass` call on a class with a member note and list now throws (this task's new guard), so the scenario itself is invalid, not just its expected values. Replace it with a test of what's actually true after this task: creating a class never advances `dataset_state.revision` or writes to `mutation_journal`, even when real synced entities are created in the same class:

```ts
  it('creating a class never advances dataset_state.revision or writes to mutation_journal, even alongside real synced entities',async()=>{
    const db=await openMigratedDatabase({ name:'test.sqlite',location:dir });
    try {
      const klass=await createClass(db,'Работа');
      const note=await createNote(db,{ title:'Идея',content:'Текст',classId:klass.id });
      const list=await createList(db,'Задачи',{ classId:klass.id });
      expect(klass).toMatchObject({ name:'Работа',rev:1,position:0,updatedAt:klass.createdAt });

      expect((await db.execute('SELECT revision FROM dataset_state')).rows).toEqual([{ revision:2 }]);
      const events=(await db.execute('SELECT dataset_revision,sequence,entity_type,entity_id,mutation,payload_json FROM mutation_journal ORDER BY dataset_revision,sequence')).rows ?? [];
      expect(events).toHaveLength(2);
      expect(events.map(row=>({ revision:row.dataset_revision,sequence:row.sequence,type:row.entity_type,mutation:row.mutation }))).toEqual([
        { revision:1,sequence:0,type:'note',mutation:'upsert' },
        { revision:2,sequence:0,type:'list',mutation:'upsert' },
      ]);
      expect(JSON.parse(events[0].payload_json as string)).toMatchObject({ id:note.id,classId:klass.id,rev:1 });
      expect(JSON.parse(events[1].payload_json as string)).toMatchObject({ id:list.id,classId:klass.id,rev:1 });
    } finally { db.close(); }
  });
```

Replace the file's second test (currently `'journals lists and items with class membership and position while retaining legacy outbox compatibility'`, lines 43-65) — its scenario stays valid (it never deletes the class), only the revision numbers and event indices shift down by one now that `createClass` no longer consumes a revision:

```ts
  it('journals lists and items with class membership and position while retaining legacy outbox compatibility',async()=>{
    const db=await openMigratedDatabase({ name:'test.sqlite',location:dir });
    try {
      const klass=await createClass(db,'Дом');
      const list=await createList(db,'Покупки',{ classId:klass.id });
      const item=await addListItem(db,list.id,'Хлеб');
      const updated=await updateListItem(db,item.id,{ checked:true });
      expect(list).toMatchObject({ classId:klass.id,position:0 });
      expect(updated).toMatchObject({ checked:true,rev:2,position:0 });
      await deleteList(db,list.id);

      expect((await db.execute('SELECT revision FROM dataset_state')).rows).toEqual([{ revision:4 }]);
      const events=(await db.execute('SELECT dataset_revision,entity_type,mutation,payload_json FROM mutation_journal ORDER BY dataset_revision')).rows ?? [];
      expect(events.map(row=>[row.dataset_revision,row.entity_type,row.mutation])).toEqual([
        [1,'list','upsert'],[2,'listItem','upsert'],[3,'listItem','upsert'],[4,'list','delete'],
      ]);
      expect(JSON.parse(events[0].payload_json as string)).toMatchObject({ id:list.id,classId:klass.id,position:0 });
      expect(JSON.parse(events[2].payload_json as string)).toMatchObject({ id:item.id,checked:true,position:0 });
      expect((await db.execute('SELECT entity_type,entity_id,deleted FROM sync_outbox')).rows).toEqual([
        { entity_type:'list',entity_id:list.id,deleted:1 },
      ]);
    } finally { db.close(); }
  });
```

No import changes needed in this file — it already imports `createClass`/`deleteClass` from `../../src/data/classes` and doesn't need `renameClass` or `deleteClassInTransaction` directly.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx jest test/data/classes.test.ts test/data/repositoryJournal.test.ts`
Expected: PASS — all tests in both files.

Run: `npx tsc --noEmit`
Expected: PASS — catches any leftover unused import or type mismatch from the `deleteClassInTransaction` signature change (`Promise<JournalEvent[]>` → `Promise<void>`).

- [ ] **Step 6: Commit**

```bash
git add src/data/classes.ts test/data/classes.test.ts test/data/repositoryJournal.test.ts
git commit -m "feat(classes): guard deleteClass, add renameClass, go local-only

A class can't be deleted while it has member notes or lists -- the
dissolve invariant (interaction-model spec) is the only way out of
membership. This makes deleteClass unconditionally pure class-only,
so it -- along with createClass and the new renameClass -- can use
runLocalOnlyTransaction instead of runLocalOperation. None of the
three touch dataset_state/mutation_journal/applied_operations anymore.
repositoryJournal.test.ts's two class-touching integration tests are
rewritten to match: one because its deleteClass-on-a-non-empty-class
scenario no longer applies, the other because revision/event indices
shift now that creating a class doesn't consume a shared revision.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 4: Server validator rejects `entityType:'class'`

**Files:**
- Modify: `src/yunote/journalBatchValidator.ts`
- Modify: `test/yunote/journalBatchRoute.test.ts`
- Test: `test/yunote/journalBatchValidator.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `validateJournalBatch` (existing export, unchanged signature) now throws for any event with `entityType:'class'`.

**Found by reading `journalBatchRoute.test.ts` in full (not assumed):** its shared `body()` helper (used by all 5 tests in that file, including a direct `validateJournalBatch` call) builds every request around a single `entityType:'class'` event — a second fixture, in a third file, that this fix breaks incidentally. Fixed here as part of this task, in its own step, ordered so it's provably neutral before the validator itself changes.

- [ ] **Step 1: Write the failing validator test**

Add to `test/yunote/journalBatchValidator.test.ts`:

```ts
describe('validateJournalBatch: class events are rejected', () => {
  it('rejects a batch containing an entityType:"class" event', () => {
    const batch = {
      replicaId: '0123456789abcdef0123456789abcdef', generation: 1, fromRevision: 1, toRevision: 1,
      events: [{ revision: 1, sequence: 0, operationId: 'op-1', entityType: 'class', entityId: 'c1', mutation: 'upsert',
        payload: { id: 'c1', name: 'Работа', rev: 1, createdAt: time, updatedAt: time, position: 0 } }],
    };
    expect(() => validateJournalBatch(batch)).toThrow(/entityType is invalid/);
  });
});
```

(`time` is already defined at the top of this test file, line 3.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/yunote/journalBatchValidator.test.ts -t "class events are rejected"`
Expected: FAIL — today's validator accepts `'class'` and the test finds no throw.

- [ ] **Step 3: Switch `journalBatchRoute.test.ts`'s shared fixture off `class`, before touching the validator**

In `test/yunote/journalBatchRoute.test.ts`, replace the `body()` helper (currently line 26-28) and the one assertion that reads it back (currently line 40):

```ts
  function body(name='Дом',extra:Record<string,unknown>={}){return JSON.stringify({replicaId,generation:1,fromRevision:1,toRevision:1,events:[
    {revision:1,sequence:0,operationId:'op-1',entityType:'note',entityId:'n',mutation:'upsert',payload:{id:'n',title:name,content:'',classId:null,rev:1,createdAt:time,updatedAt:time,position:0}},
  ],...extra});}
```

and:

```ts
      expect(db.prepare('SELECT title FROM yunote_notes').get()).toEqual({title:'Дом'});
```

Every other test in the file (`rejects unknown fields...`, `rejects a malformed revision series...`, `requires installation authentication`, `accepts empty user text...`) calls `body(...)` positionally or mutates its parsed JSON generically — none of them reference `class` by name, so they need no further change; switching the fixture's entity type is the entire fix for this file. `text()` (the validator's field-length check, used for both the old `class.name` and the new `note.title`) has no non-empty requirement either way, so the `accepts empty user text` test's behavior is preserved exactly.

Run: `npx jest test/yunote/journalBatchRoute.test.ts`
Expected: PASS — against today's *unchanged* validator, proving this step is a neutral fixture swap, not something that happens to work only once Step 4 lands.

- [ ] **Step 4: Remove `'class'` from the validator**

In `src/yunote/journalBatchValidator.ts`:

Line 4, change:
```ts
const TYPES=new Set(['class','note','list','listItem']);
```
to:
```ts
const TYPES=new Set(['note','list','listItem']);
```

Lines 20-25 (`payloadFor`'s `fields` ternary), remove the `type==='class'` branch:
```ts
function payloadFor(type:string,value:unknown,path:string):Obj {
  const p=obj(value,path);
  const fields=type==='note'?['id','title','content','classId','rev','createdAt','updatedAt','position']:
    type==='list'?['id','title','classId','position','purpose','sharingMode','sharedRevision','collaborationRole','rev','createdAt','updatedAt']:
    ['id','listId','text','checked','position','completedByPublicClientId','completedByDisplayName','completedByHasAvatar','completedByAvatarVersion','completedByAvatarDataUri','rev','createdAt','updatedAt'];
  keys(p,fields,path); common(p,path);
  if(type==='note'){text(p.title,`${path}.title`,500);text(p.content,`${path}.content`,65_536);if(p.classId!==null)str(p.classId,`${path}.classId`);}
  ...
```

Line 27 (`if(type==='class')text(p.name,...)`) — delete it entirely.

- [ ] **Step 5: Run all affected tests to verify they pass**

Run: `npx jest test/yunote/journalBatchValidator.test.ts test/yunote/journalBatchRoute.test.ts`
Expected: PASS — all tests in both files, including the new rejection test and every existing list/note/listItem test.

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/yunote/journalBatchValidator.ts test/yunote/journalBatchValidator.test.ts test/yunote/journalBatchRoute.test.ts
git commit -m "fix(yunote): reject entityType:class in journal batches

The server no longer understands Class as a synchronized entity.
Explicit rejection, not silent tolerance -- matches how every other
malformed event is already handled. journalBatchRoute.test.ts's shared
fixture used a class event as its generic 'any valid request' vehicle
across the whole file -- switched to a note event first, as a neutral
step, before the validator itself changed.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 5: Server store drops the class persistence path

**Files:**
- Modify: `src/yunote/journalBatchStore.ts`
- Test: `test/yunote/journalBatchStore.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `YunoteJournalEvent['entityType']` narrows from `'class'|'note'|'list'|'listItem'` to `'note'|'list'|'listItem'`. `createYunoteJournalBatchStore` (existing export) keeps its signature; `apply()` now has no code path that can write to `yunote_classes`.

**Important, found by reading the existing test file in full (not assumed):** the shared `batch` fixture at the top of `test/yunote/journalBatchStore.test.ts`, and three of the file's existing `it(...)` blocks, use `entityType:'class'` as ordinary test data — including as the *only* event at revision 1, which is exactly the "revision with nothing to journal" shape this whole fix exists to prevent. This step rewrites those parts, not just adds one new test. It replaces the entire file rather than patching fragments, because removing the class event changes revision numbering (`toRevision` drops from 3 to 2) and that number is repeated across several tests — patching them independently risks an inconsistent off-by-one.

- [ ] **Step 1: Replace the whole test file with the failing version**

Replace the full contents of `test/yunote/journalBatchStore.test.ts` with:

```ts
import { generateKeyPairSync,randomUUID } from 'node:crypto';
import { openDatabase } from '../../src/db/db';
import { createYunoteJournalBatchStore,type YunoteJournalBatch } from '../../src/yunote/journalBatchStore';
import {decrypt,encrypt} from '../../src/auth/tokenEncryption';

const SOURCE_KEY='11'.repeat(32);

const time='2026-09-11T12:00:00.000Z';
const replica='0123456789abcdef0123456789abcdef';
const hashA='a'.repeat(64);
const hashB='b'.repeat(64);

describe('yuNote journal batch store',()=>{
  function build() {
    const db=openDatabase(':memory:'); const publicKey=generateKeyPairSync('ec',{namedCurve:'prime256v1'}).publicKey.export({type:'spki',format:'pem'}).toString();
    db.prepare(`INSERT INTO users (user_id,email,password_hash,consented_at,privacy_policy_version,created_at)
      VALUES ('user-1','u@example.test','x',?,'1',?)`).run(time,time);
    db.prepare(`INSERT INTO yunote_installations (installation_id,user_id,public_key_pem,key_version,status,created_at)
      VALUES (?,'user-1',?,1,'active',?)`).run(randomUUID(),publicKey,time);
    const installationId=(db.prepare('SELECT installation_id FROM yunote_installations').get() as {installation_id:string}).installation_id;
    db.prepare(`INSERT INTO yunote_replica_bindings
      (binding_id,user_id,installation_id,replica_id,generation,applied_revision,status,created_at,updated_at)
      VALUES ('binding-1','user-1',?,?,1,0,'active',?,?)`).run(installationId,replica,time,time);
    return {db,store:createYunoteJournalBatchStore(db,SOURCE_KEY)};
  }

  // Two revisions, not three -- the original fixture opened with an
  // entityType:'class' event alone at revision 1, which is exactly the
  // "revision with nothing to journal" shape this fix exists to prevent.
  // class_id stays as an ordinary opaque string on list/note payloads
  // (§5 of the sync-boundary-fix spec) -- not exercised here since this
  // file is about the store's entity-persistence behavior, not class_id
  // semantics specifically.
  const batch:YunoteJournalBatch={fromRevision:1,toRevision:2,events:[
    {revision:1,sequence:0,operationId:'op-1',entityType:'list',entityId:'l',mutation:'upsert',payload:{id:'l',title:'Покупки',classId:null,rev:1,createdAt:time,updatedAt:time,position:1}},
    {revision:1,sequence:1,operationId:'op-1',entityType:'note',entityId:'n',mutation:'upsert',payload:{id:'n',title:'Адрес',content:'Текст',classId:null,rev:1,createdAt:time,updatedAt:time,position:3}},
    {revision:2,sequence:0,operationId:'op-2',entityType:'listItem',entityId:'i',mutation:'upsert',payload:{id:'i',listId:'l',text:'Хлеб',checked:false,rev:1,createdAt:time,updatedAt:time,position:2}},
  ]};

  it('applies every entity and advances the cursor only after writing a receipt',()=>{
    const {db,store}=build();
    try {
      for(const id of ['l','n'])db.prepare('INSERT INTO note_embeddings (note_id,vector_json,created_at) VALUES (?,\'[1]\',?)').run(id,time);
      expect(store.apply({userId:'user-1',bindingId:'binding-1',replicaId:replica,generation:1,batch,payloadHash:hashA,nowMs:Date.parse(time)})).toEqual({status:'applied',ackRevision:2});
      expect(db.prepare('SELECT title FROM yunote_lists').get()).toEqual({title:'Покупки'});
      expect(db.prepare('SELECT title FROM yunote_notes').get()).toEqual({title:'Адрес'});
      expect(db.prepare('SELECT text FROM yunote_list_items').get()).toEqual({text:'Хлеб'});
      expect(db.prepare('SELECT class_id,position FROM yunote_list_organization').get()).toEqual({class_id:null,position:1});
      expect(db.prepare('SELECT class_id,position FROM yunote_note_organization').get()).toEqual({class_id:null,position:3});
      expect(db.prepare('SELECT applied_revision FROM yunote_replica_bindings').get()).toEqual({applied_revision:2});
      expect(db.prepare('SELECT COUNT(*) AS count FROM note_embeddings').get()).toEqual({count:0});
      expect(db.prepare('SELECT from_revision,to_revision,payload_hash FROM yunote_journal_batches').get()).toEqual({from_revision:1,to_revision:2,payload_hash:hashA});
    } finally {db.close();}
  });

  it('returns the same ack for an exact replay and rejects a changed replay',()=>{
    const {db,store}=build(); const input={userId:'user-1',bindingId:'binding-1',replicaId:replica,generation:1,batch,nowMs:Date.parse(time)};
    try {
      expect(store.apply({...input,payloadHash:hashA}).status).toBe('applied');
      expect(store.apply({...input,payloadHash:hashA})).toEqual({status:'replayed',ackRevision:2});
      expect(store.apply({...input,payloadHash:hashB})).toEqual({status:'changed_replay',ackRevision:2});
      expect(db.prepare('SELECT COUNT(*) AS count FROM yunote_journal_batches').get()).toEqual({count:1});
    } finally {db.close();}
  });

  it('distinguishes a future gap from an unrecorded overlap',()=>{
    const {db,store}=build();
    const shifted:YunoteJournalBatch={fromRevision:2,toRevision:3,events:batch.events.map(event=>({...event,revision:event.revision+1}))};
    try {
      expect(store.apply({userId:'user-1',bindingId:'binding-1',replicaId:replica,generation:1,batch:shifted,payloadHash:hashA,nowMs:0}).status).toBe('gap');
      db.prepare("UPDATE yunote_replica_bindings SET applied_revision=2 WHERE binding_id='binding-1'").run();
      expect(store.apply({userId:'user-1',bindingId:'binding-1',replicaId:replica,generation:1,batch:shifted,payloadHash:hashA,nowMs:0}).status).toBe('overlap');
    } finally {db.close();}
  });

  it('rolls back earlier events, cursor, and receipt when any event fails',()=>{
    const {db,store}=build(); const broken:YunoteJournalBatch={fromRevision:1,toRevision:2,events:[
      {revision:1,sequence:0,operationId:'op-1',entityType:'list',entityId:'l',mutation:'upsert',payload:{id:'l',title:'Покупки',classId:null,rev:1,createdAt:time,updatedAt:time,position:0}},
      {revision:2,sequence:0,operationId:'op-2',entityType:'listItem',entityId:'i',mutation:'upsert',payload:{id:'i',listId:'missing',text:'Хлеб',checked:false,rev:1,createdAt:time,updatedAt:time,position:0}},
    ]};
    try {
      expect(()=>store.apply({userId:'user-1',bindingId:'binding-1',replicaId:replica,generation:1,batch:broken,payloadHash:hashA,nowMs:0})).toThrow();
      expect(db.prepare('SELECT COUNT(*) AS count FROM yunote_lists').get()).toEqual({count:0});
      expect(db.prepare('SELECT applied_revision FROM yunote_replica_bindings').get()).toEqual({applied_revision:0});
      expect(db.prepare('SELECT COUNT(*) AS count FROM yunote_journal_batches').get()).toEqual({count:0});
    } finally {db.close();}
  });

  it('rejects an entity revision jump and oversized ranges before changing data',()=>{
    const {db,store}=build();
    try {
      const jumped:YunoteJournalBatch={fromRevision:1,toRevision:1,events:[
        {revision:1,sequence:0,operationId:'op',entityType:'list',entityId:'l',mutation:'upsert',payload:{id:'l',title:'Покупки',classId:null,rev:2,createdAt:time,updatedAt:time,position:0}},
      ]};
      expect(()=>store.apply({userId:'user-1',bindingId:'binding-1',replicaId:replica,generation:1,batch:jumped,payloadHash:hashA,nowMs:0})).toThrow(/revision/i);
      expect(()=>store.apply({userId:'user-1',bindingId:'binding-1',replicaId:replica,generation:1,batch:{fromRevision:1,toRevision:101,events:[]},payloadHash:hashA,nowMs:0})).toThrow(/limit/i);
      expect(db.prepare('SELECT applied_revision FROM yunote_replica_bindings').get()).toEqual({applied_revision:0});
    } finally {db.close();}
  });

  it('apply() throws given an entityType:"class" event (defense in depth, e.g. a stale client build)',()=>{
    const {db,store}=build();
    const malformed={fromRevision:1,toRevision:1,events:[
      {revision:1,sequence:0,operationId:'op-1',entityType:'class',entityId:'c',mutation:'upsert',payload:{id:'c',name:'Дом',rev:1,createdAt:time,updatedAt:time,position:0}},
    ]} as unknown as YunoteJournalBatch;
    try {
      expect(()=>store.apply({userId:'user-1',bindingId:'binding-1',replicaId:replica,generation:1,batch:malformed,payloadHash:hashA,nowMs:0})).toThrow();
    } finally {db.close();}
  });

  it('accepts offline mutations for a Shopping List source after partner activation removed the public replica',()=>{
    const {db,store}=build();
    try{
      db.prepare(`INSERT INTO collaborative_lists (id,title,normalized_title,purpose,sharing_mode,status,revision,created_by_user_id,created_at,updated_at)
        VALUES ('partner','Shopping List','shopping list','shopping','partner','active',1,'user-1',?,?)`).run(time,time);
      db.prepare(`INSERT INTO partner_source_lists (user_id,source_list_id,partner_list_id,title,rev,created_at,updated_at)
        VALUES ('user-1','old-shopping','partner','Shopping List',4,?,?)`).run(time,time);
      db.prepare(`INSERT INTO partner_source_items (user_id,id,source_list_id,text_cipher,checked,rev,created_at,updated_at)
        VALUES ('user-1','milk','old-shopping',?,0,1,?,?)`).run(encrypt('Milk',SOURCE_KEY),time,time);
      const redirected:YunoteJournalBatch={fromRevision:1,toRevision:2,events:[
        {revision:1,sequence:0,operationId:'edit-list',entityType:'list',entityId:'old-shopping',mutation:'upsert',payload:{id:'old-shopping',title:'Shopping List',classId:null,position:0,rev:5,createdAt:time,updatedAt:time}},
        {revision:2,sequence:0,operationId:'edit-item',entityType:'listItem',entityId:'milk',mutation:'upsert',payload:{id:'milk',listId:'old-shopping',text:'Milk ×2',checked:false,position:0,rev:2,createdAt:time,updatedAt:time}},
      ]};
      expect(store.apply({userId:'user-1',bindingId:'binding-1',replicaId:replica,generation:1,batch:redirected,payloadHash:hashA,nowMs:Date.parse(time)})).toEqual({status:'applied',ackRevision:2});
      expect(db.prepare("SELECT title,rev FROM partner_source_lists WHERE source_list_id='old-shopping'").get()).toEqual({title:'Shopping List',rev:5});
      const stored=db.prepare("SELECT text_cipher,rev,deleted FROM partner_source_items WHERE id='milk'").get() as {text_cipher:string;rev:number;deleted:number};
      expect(stored.text_cipher).not.toContain('Milk');
      expect({...stored,text:decrypt(stored.text_cipher,SOURCE_KEY)}).toMatchObject({text:'Milk ×2',rev:2,deleted:0});
    }finally{db.close();}
  });

  it('keeps a source tombstone so deleting an offline Shopping List still triggers partner rebase',()=>{
    const {db,store}=build();
    try{
      db.prepare(`INSERT INTO collaborative_lists (id,title,normalized_title,purpose,sharing_mode,status,revision,created_by_user_id,created_at,updated_at)
        VALUES ('partner','Shopping List','shopping list','shopping','partner','active',1,'user-1',?,?)`).run(time,time);
      db.prepare(`INSERT INTO partner_source_lists (user_id,source_list_id,partner_list_id,title,rev,created_at,updated_at)
        VALUES ('user-1','old-shopping','partner','Shopping List',4,?,?)`).run(time,time);
      db.prepare(`INSERT INTO partner_source_items (user_id,id,source_list_id,text_cipher,checked,rev,created_at,updated_at)
        VALUES ('user-1','milk','old-shopping',?,0,1,?,?)`).run(encrypt('Milk',SOURCE_KEY),time,time);
      const batch:YunoteJournalBatch={fromRevision:1,toRevision:1,events:[{revision:1,sequence:0,operationId:'delete-list',entityType:'list',entityId:'old-shopping',mutation:'delete'}]};
      expect(store.apply({userId:'user-1',bindingId:'binding-1',replicaId:replica,generation:1,batch,payloadHash:hashA,nowMs:Date.parse(time)}).status).toBe('applied');
      expect(db.prepare("SELECT deleted FROM partner_source_lists WHERE source_list_id='old-shopping'").get()).toEqual({deleted:1});
      expect(db.prepare("SELECT deleted FROM partner_source_items WHERE id='milk'").get()).toEqual({deleted:1});
    }finally{db.close();}
  });
});
```

Changes from the current file, precisely: the shared `batch` drops its `class` event and renumbers to 2 revisions (was 3); every `ackRevision`/`applied_revision`/`to_revision` value derived from it changes `3`→`2` accordingly; the `yunote_classes` assertion in the first test is removed; the "rolls back on failure" test's first event switches from `class`/`c` to `list`/`l` (still a valid, successful first event with a bad second event to force rollback — same mechanism, different entity type) and its rollback assertion switches from `yunote_classes` count to `yunote_lists` count; the "revision jump" test switches its vehicle from `class`/`c` to `list`/`l`; a new dedicated defense-in-depth test is added. The two Shopping-List/partner tests at the bottom are untouched (they never referenced `class`).

- [ ] **Step 2: Run tests to verify the new/changed ones fail appropriately**

Run: `npx jest test/yunote/journalBatchStore.test.ts`
Expected: FAIL — today's `journalBatchStore.ts` still has a `class` case, so the new defense-in-depth test doesn't throw yet (the store happily processes it instead); the other tests fail only if there's a numbering slip, which the exact values above are written to avoid — if any of them fail for a reason other than the defense-in-depth test, stop and recheck the arithmetic before proceeding, don't paper over it in Step 3.

- [ ] **Step 3: Remove class handling from the store**

In `src/yunote/journalBatchStore.ts`:

Line 4, change:
```ts
type EntityType='class'|'note'|'list'|'listItem';
```
to:
```ts
type EntityType='note'|'list'|'listItem';
```

This makes TypeScript flag every remaining `class`-keyed reference below as an error — fix each one it points to:

- Line 46: remove `class:db.prepare('SELECT rev FROM yunote_classes WHERE user_id=? AND id=?'),` from the `selectRev` object literal.
- Lines 51-52: delete the `upsertClass` statement entirely.
- Line 66: remove `class:db.prepare('DELETE FROM yunote_classes WHERE user_id=? AND id=?'),` from the `deleteRows` object literal.
- Line 107: delete the `case 'class': upsertClass.run(...); break;` line from the `switch(event.entityType)` block in `applyEvent`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest test/yunote/journalBatchStore.test.ts`
Expected: PASS — all 9 tests, including the new defense-in-depth one (it now throws — `selectRev[event.entityType]` is `undefined` for the unrecognized string `'class'`, so `.get(...)` throws a `TypeError`, satisfying "fails loudly," which is what the test checks for, not a specific error message).

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/yunote/journalBatchStore.ts test/yunote/journalBatchStore.test.ts
git commit -m "fix(yunote): remove class persistence path from journal store

No code path in journalBatchStore can write to yunote_classes anymore,
matching the validator's rejection from the previous commit -- defense
in depth against a store call that somehow bypasses validation. The
existing test fixture used a class event as incidental test data in
several places, including alone at revision 1 -- rewritten to use
other entity types for the same rollback/revision-jump mechanisms
without relying on data this fix removes.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 6: Drop `yunote_classes` and the dangling FK

**Do this task after Task 7 and Task 8, not before** — both of them `db.prepare` a statement against `yunote_classes` at module/store-construction time; dropping the table first makes those throw immediately, not just on the code path that used to touch classes.

**Files:**
- Modify: `src/db/schema.sql`
- Modify: `src/db/db.ts`
- Test: `test/db.test.ts`

**Interfaces:**
- Consumes: `tableExists` (existing helper in `db.ts`, confirmed present).
- Produces: `migrateYunoteDropClassSync(db: Database.Database): void` — new, called from `openDatabase()`.

**Found by reading `test/db.test.ts` in full (not assumed):** two existing, currently-passing tests already assert `yunote_classes` exists — `'creates all schema tables'` (an exact, ordered list of every table in the database) and `'keeps organization additive instead of altering the existing replica tables'` (an exact 4-table list of organization tables). Both need updating as part of this task, before the new migration tests are added, or they'll fail for a reason unrelated to what this task is trying to prove.

- [ ] **Step 1: Fix the two existing tests that assert `yunote_classes` exists**

In `test/db.test.ts`, remove the line `'yunote_classes',` from the exact table list in `'creates all schema tables'` (currently line 34, between `'users',` and `'yunote_installations',`).

In `'keeps organization additive instead of altering the existing replica tables'`, change the query (currently lines 91-93):

```ts
    const organizationTables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('yunote_note_organization','yunote_list_organization','yunote_item_organization') ORDER BY name",
    ).all() as Array<{ name:string }>;
    expect(organizationTables.map((row) => row.name)).toEqual([
      'yunote_item_organization',
      'yunote_list_organization',
      'yunote_note_organization',
    ]);
```

These two edits alone will make both tests FAIL against today's `openDatabase` (which still creates `yunote_classes`) — that's expected and correct at this point; Steps 3-4 below are what make them pass again, once the table is actually gone.

- [ ] **Step 2: Write the new failing tests**

Add to `test/db.test.ts`:

```ts
describe('migrateYunoteDropClassSync', () => {
  it('a fresh database has no yunote_classes table', () => {
    const db = openDatabase(':memory:');
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='yunote_classes'").get();
    expect(table).toBeUndefined();
  });

  it('a fresh database\'s organization tables have no FK to yunote_classes', () => {
    const db = openDatabase(':memory:');
    const fks = db.prepare("PRAGMA foreign_key_list(yunote_note_organization)").all() as { table: string }[];
    expect(fks.some(fk => fk.table === 'yunote_classes')).toBe(false);
  });

  it('migrating an existing database with yunote_classes preserves organization rows, position, and opaque class_id values', () => {
    const Database = require('better-sqlite3');
    const raw = new Database(':memory:');
    raw.pragma('foreign_keys = ON');
    // Build the OLD shape directly (pre-migration), matching schema.sql
    // before this task's edit -- yunote_classes plus the FK-bearing
    // organization tables, with the minimal set of tables migrateYunoteDropClassSync
    // actually touches or depends on.
    raw.exec(`
      CREATE TABLE users (user_id TEXT PRIMARY KEY);
      CREATE TABLE yunote_notes (user_id TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, rev INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (user_id, id));
      CREATE TABLE yunote_lists (user_id TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, rev INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (user_id, id));
      CREATE TABLE yunote_classes (id TEXT NOT NULL, user_id TEXT NOT NULL, name TEXT NOT NULL, rev INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, id));
      CREATE TABLE yunote_note_organization (user_id TEXT NOT NULL, id TEXT NOT NULL, class_id TEXT, position INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, id), FOREIGN KEY (user_id, id) REFERENCES yunote_notes(user_id, id) ON DELETE CASCADE, FOREIGN KEY (user_id, class_id) REFERENCES yunote_classes(user_id, id));
      CREATE TABLE yunote_list_organization (user_id TEXT NOT NULL, id TEXT NOT NULL, class_id TEXT, position INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, id), FOREIGN KEY (user_id, id) REFERENCES yunote_lists(user_id, id) ON DELETE CASCADE, FOREIGN KEY (user_id, class_id) REFERENCES yunote_classes(user_id, id));
    `);
    raw.exec(`
      INSERT INTO users (user_id) VALUES ('u1');
      INSERT INTO yunote_notes (user_id,id,title,content,rev,created_at,updated_at) VALUES ('u1','n1','T','C',1,'t','t');
      INSERT INTO yunote_notes (user_id,id,title,content,rev,created_at,updated_at) VALUES ('u1','n2','T2','C2',1,'t','t');
      INSERT INTO yunote_classes (id,user_id,name,rev,created_at,updated_at,position) VALUES ('c1','u1','Работа',1,'t','t',0);
      INSERT INTO yunote_note_organization (user_id,id,class_id,position) VALUES ('u1','n1','c1',3);
      INSERT INTO yunote_note_organization (user_id,id,class_id,position) VALUES ('u1','n2',NULL,7);
    `);

    migrateYunoteDropClassSync(raw);

    const rows = raw.prepare('SELECT id,class_id,position FROM yunote_note_organization ORDER BY id').all();
    expect(rows).toEqual([
      { id: 'n1', class_id: 'c1', position: 3 },
      { id: 'n2', class_id: null, position: 7 },
    ]);
    const table = raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='yunote_classes'").get();
    expect(table).toBeUndefined();
    const violations = raw.pragma('foreign_key_check');
    expect(violations).toEqual([]);
  });

  it('migration is idempotent -- running it twice does not throw', () => {
    const db = openDatabase(':memory:'); // already migrated via schema.sql
    expect(() => migrateYunoteDropClassSync(db)).not.toThrow();
  });
});
```

Add `migrateYunoteDropClassSync` to the test file's import from `../src/db/db` (it isn't exported yet — Step 5 exports it).

- [ ] **Step 3: Run the new tests to verify they fail**

Run: `npx jest test/db.test.ts -t "migrateYunoteDropClassSync"`
Expected: FAIL — `migrateYunoteDropClassSync` doesn't exist, and a fresh `openDatabase(':memory:')` still creates `yunote_classes` today.

- [ ] **Step 4: Update `schema.sql`**

In `src/db/schema.sql`, delete the `yunote_classes` table definition (lines 304-313, the block starting `CREATE TABLE IF NOT EXISTS yunote_classes (` through its closing `);`).

In the `yunote_note_organization` definition (lines 319-327), remove the trailing FK line and its preceding comma:
```sql
CREATE TABLE IF NOT EXISTS yunote_note_organization (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  class_id TEXT,
  position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
  PRIMARY KEY (user_id, id),
  FOREIGN KEY (user_id, id) REFERENCES yunote_notes(user_id, id) ON DELETE CASCADE
);
```

Apply the same change to `yunote_list_organization` (lines 329-337) — same edit, `yunote_lists` instead of `yunote_notes`.

- [ ] **Step 5: Add the migration function to `db.ts`**

In `src/db/db.ts`, add after `migrateYunoteInstallationKeyRotation` (whatever line it ends on after prior edits — insert immediately below its closing brace):

```ts
// Existing databases created before this fix (see
// docs/superpowers/specs/2026-09-17-yunote-classes-sync-boundary-fix-design.md)
// have a yunote_classes table and organization tables with a dangling-
// once-dropped FK to it. Classes were never meant to sync -- this
// removes the table and the FK it leaves behind, keeping every existing
// organization row (including position, which is unrelated to classes
// and must survive) and any existing class_id value as an ordinary
// opaque string the server no longer interprets.
function migrateYunoteDropClassSync(db: Database.Database): void {
  if (!tableExists(db, 'yunote_classes')) return;
  const migrate = db.transaction(() => {
    db.exec('ALTER TABLE yunote_note_organization RENAME TO yunote_note_organization_old');
    db.exec(`
      CREATE TABLE yunote_note_organization (
        user_id TEXT NOT NULL, id TEXT NOT NULL, class_id TEXT,
        position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
        PRIMARY KEY (user_id, id),
        FOREIGN KEY (user_id, id) REFERENCES yunote_notes(user_id, id) ON DELETE CASCADE
      )`);
    db.exec(`INSERT INTO yunote_note_organization (user_id, id, class_id, position)
      SELECT user_id, id, class_id, position FROM yunote_note_organization_old`);
    db.exec('DROP TABLE yunote_note_organization_old');

    db.exec('ALTER TABLE yunote_list_organization RENAME TO yunote_list_organization_old');
    db.exec(`
      CREATE TABLE yunote_list_organization (
        user_id TEXT NOT NULL, id TEXT NOT NULL, class_id TEXT,
        position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
        PRIMARY KEY (user_id, id),
        FOREIGN KEY (user_id, id) REFERENCES yunote_lists(user_id, id) ON DELETE CASCADE
      )`);
    db.exec(`INSERT INTO yunote_list_organization (user_id, id, class_id, position)
      SELECT user_id, id, class_id, position FROM yunote_list_organization_old`);
    db.exec('DROP TABLE yunote_list_organization_old');

    db.exec('DROP TABLE yunote_classes');
  });
  migrate();

  // No existing migration in this codebase verifies FK integrity after a
  // structural change -- added specifically here because this migration
  // recreates two FK-bearing tables under foreign_keys=ON, and a silent
  // dangling reference would only surface later as an opaque write
  // failure on an unrelated note/list update. New precedent, not an
  // established one.
  const violations = db.pragma('foreign_key_check') as unknown[];
  if (violations.length > 0) {
    throw new Error(`Post-migration foreign key check found ${violations.length} violation(s)`);
  }
}
```

Register it in `openDatabase()`, after the existing `migrateYunoteInstallationKeyRotation(db);` call:

```ts
  migrateYunoteInstallationKeyRotation(db);
  migrateYunoteDropClassSync(db);
```

Export `migrateYunoteDropClassSync` (add `export` to its declaration) so the test file can call it directly against a hand-built old-shape database, matching how the test in Step 2 uses it.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx jest test/db.test.ts`
Expected: PASS — all tests in the file, including the two fixed in Step 1 and the new ones from Step 2.

Run: `npx tsc --noEmit`
Expected: PASS.

Run the full server test suite once, since this task touches shared schema/migration machinery other tests depend on implicitly:

Run: `npm test`
Expected: PASS, no regressions elsewhere.

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.sql src/db/db.ts test/db.test.ts
git commit -m "fix(yunote): drop yunote_classes and its dangling FK

Classes were never meant to sync. Drops the now-pointless table and
the FK the organization tables held against it, while preserving every
existing organization row's position and class_id (now an ordinary
opaque string the server never interprets). Verified with
PRAGMA foreign_key_check after the migration -- new precedent for this
codebase's migrations, added because this one recreates two FK-bearing
tables under foreign_keys=ON.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 7: Remove `classes` from the snapshot schema (both sides)

**Files:**
- Modify: `cloud-platform/src/yunote/snapshot.ts`
- Modify: `cloud-platform/src/yunote/snapshotStore.ts`
- Modify: `cloud-platform/src/yunote/installationStore.ts`
- Test: `cloud-platform/test/yunote/snapshot.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `YunoteSnapshot` drops its `classes` field; `validateSnapshot`'s accepted key set and its `classId` cross-reference check both shrink to match; `readSnapshot`'s returned object no longer has a `classes` property.

**Critically, this task must land before or together with Task 6** — `readSnapshot` currently queries `yunote_classes` directly, and it runs live during every enrollment request (`installationStore.ts` line 97, spec §8). If Task 6 drops the table before this task removes the query, enrollment breaks immediately on the next request, not eventually.

**Found during execution, not in this task's original file list:** `installationStore.ts:98` reads `cloudSnapshot.classes.length` directly (as part of computing whether the cloud side has any data at all, before deciding whether to enforce a conflict check) — a second, real production call site this task's own type change breaks, missed by the original planning pass the same way `test/data/repositoryJournal.test.ts` was missed for Task 3. Fixed in Step 5 below. This is a one-line, purely mechanical fix (drop one clause from a boolean expression), not a design change — `installationStore.ts`'s own enrollment logic, hashing, and conflict-detection behavior are otherwise untouched.

- [ ] **Step 1: Rewrite the test file**

`test/yunote/snapshot.test.ts`'s `addClass()` helper and most of its tests exist specifically to exercise `yunote_classes` — once that table and the snapshot's `classes` field are both gone, most of what they test no longer exists to test. Going test-by-test against the current file:

- Delete the `addClass()` helper function entirely (currently lines 22-25).
- Delete the test `'allows identical class ids for different users but rejects cross-user membership'` entirely (lines 32-38) — it tests `yunote_classes`'s own per-user uniqueness/FK behavior, a table this task removes.
- In `'purges organization and classes with a replica without touching the other user'` (lines 40-51): remove both `addClass(db,user)` calls, and remove `'yunote_classes'` from the table list being checked (line 48's array), keeping the other three organization tables' purge assertions.
- In `'adds organization to an existing database without changing its note/list/item rows'` (lines 53-68): remove the `addClass(disk,'a')` call (line 64) and the two assertions around it (lines 65-66) that read `yunote_classes` back — the rest of the test (verifying note/list/item rows survive a migration onto a pre-organization-tables database) is unrelated to classes and stays.
- In `'reads an exact, user-scoped snapshot in deterministic display order'` (lines 70-85): remove the two `addClass(db, ...)` calls and the `UPDATE yunote_classes` line, remove `class_id`/`class_id,position` from the two `INSERT INTO ...organization` calls (or pass `NULL` explicitly — either way the row no longer needs a real class to reference), and remove the `classes: [...]` line and its value from the expected object, along with changing `classId:'c'` to `classId:null` in the expected `notes`/`lists` entries.
- `'uses safe legacy defaults when organization rows do not exist'` (lines 87-92): unaffected, no `classes` reference.
- In `'strictly validates references, duplicate ids, numeric bounds, and unknown fields'` (lines 94-103): remove line 100's `classes:[{...rev:0...}]` assertion (there's no `classes` field left to malform); replace it with an equivalent rev-bounds check on a field that still exists, e.g. `expect(() => validateSnapshot({ ...valid, notes:[{ ...valid.notes[0], rev:0 }] })).toThrow(/rev/i);`, so this test still covers the numeric-bounds case it's named for.
- `'reports a corrupt SQLite boolean instead of silently normalizing it'` (lines 105-108): unaffected.
- In `'keeps ordinary deletes working after organization rows exist'` (lines 110-121): remove the `addClass(db,'a')` call and drop `class_id` from the two `INSERT INTO ...organization` calls (or pass `NULL`) — the test's actual subject (deleting a note/list cleans up its organization row) is otherwise unchanged.
- In `'returns an empty versioned snapshot for a user without data'` (lines 123-126): remove `classes:[]` from the expected object.
- In `'uses position then id as the stable order and keeps classes out of AI candidates'` (lines 128-137): remove both `addClass(db,'a',...)` calls, the `UPDATE yunote_classes` line, and the `readSnapshot(db,'a').classes...` assertion (line 132) — the note-ordering assertion (line 133) stays, it's unrelated to classes. Remove the trailing `listCandidates(...).not.toEqual(...)` assertion (lines 134-136) — `listCandidates` never queried `yunote_classes` to begin with (confirmed directly in `yunoteSyncStore.ts`), so this was documenting an absence that was already structurally guaranteed, not testing a real filter; once nothing ever creates a class in this test, the assertion becomes vacuous rather than stronger. Rename the test to drop "and keeps classes out of AI candidates" from its title.

- [ ] **Step 2: Run tests to verify the rewritten file fails against today's source**

Run: `npx jest test/yunote/snapshot.test.ts`
Expected: FAIL — today's `snapshotStore.ts`/`snapshot.ts` still include `classes`, so `readSnapshot`'s actual output still has a `classes` key the rewritten tests no longer expect.

- [ ] **Step 3: Remove `classes` from `snapshot.ts`**

In `src/yunote/snapshot.ts`:
- Delete the `YunoteSnapshotClass` interface (lines 1-8) — nothing constructs one anymore.
- In `YunoteSnapshot` (lines 42-48), remove the `classes: YunoteSnapshotClass[];` line.
- In `validateSnapshot` (starting line 111): change `exactKeys(root, ['schemaVersion','classes','notes','lists','listItems'], 'snapshot')` to `exactKeys(root, ['schemaVersion','notes','lists','listItems'], 'snapshot')`. Delete the `classes`/`classIds` block (lines 116-122) entirely. In the `for (const row of [...notes, ...lists])` loop (lines 151-153), remove the `if (row.classId !== null && !classIds.has(row.classId)) throw ...` check — `classId` is opaque now, matching the database schema (spec §5); nothing validates it against a known set anymore.

- [ ] **Step 4: Remove `classes` from `snapshotStore.ts`**

In `src/yunote/snapshotStore.ts`, delete the `const classes = db.prepare(...)` statement (lines 8-9) and remove `classes` from the returned object on line 20 (`return { schemaVersion:1, classes, notes, lists, listItems };` → `return { schemaVersion:1, notes, lists, listItems };`).

- [ ] **Step 5: Fix `installationStore.ts`'s `cloudIsEmpty` check**

In `src/yunote/installationStore.ts`, line 98 currently reads:

```ts
const cloudIsEmpty=cloudSnapshot.classes.length===0&&cloudSnapshot.notes.length===0&&cloudSnapshot.lists.length===0&&cloudSnapshot.listItems.length===0;
```

Change to:

```ts
const cloudIsEmpty=cloudSnapshot.notes.length===0&&cloudSnapshot.lists.length===0&&cloudSnapshot.listItems.length===0;
```

Nothing else on this line, or in this file, needs to change — `cloudHash` (line 99) is computed by hashing `cloudSnapshot` as a whole, so once `readSnapshot`'s return shape no longer has `classes` (Step 4), that hash automatically reflects the new shape without its own edit.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx jest test/yunote/snapshot.test.ts`
Expected: PASS — all remaining tests (one fewer than before, since Step 1 deleted one entirely).

Run: `npx jest` (full cloud-platform suite) and `npx tsc --noEmit`
Expected: PASS — this also re-confirms Tasks 4-6's tests still pass together with this one, since `installationStore.ts`'s enrollment-conflict check (spec §8) depends on `readSnapshot`'s shape matching what enrollment tests expect. `tsc --noEmit` in particular must go from failing (16 suites, one compile error each, all at `installationStore.ts:98`) to clean.

- [ ] **Step 7: Commit**

```bash
git add src/yunote/snapshot.ts src/yunote/snapshotStore.ts src/yunote/installationStore.ts test/yunote/snapshot.test.ts
git commit -m "fix(yunote): remove classes from the snapshot schema

readSnapshot ran live on every device enrollment (installationStore.ts)
to detect cloud-vs-local conflicts -- with yunote_classes dropped
(previous commit), it would have crashed on the next enrollment
request. Classes leave the snapshot schema entirely on the server
side, matching the rest of this fix: they never reach another device,
full stop, not just via the incremental journal path.
installationStore.ts's own cloudIsEmpty check read cloudSnapshot.classes
directly and needed the same one-line fix, found only once the type
change actually broke compilation -- missed by this plan's original
file survey the same way test/data/repositoryJournal.test.ts was
missed for Task 3.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 8: Account deletion no longer purges a table that won't exist

**Files:**
- Modify: `cloud-platform/src/auth/yunoteSyncStore.ts`
- Test: `cloud-platform/test/yunote/snapshot.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `createYunoteSyncStore`'s returned `deleteAllForUser` keeps its existing signature and behavior for notes/lists/listItems/organization; it just no longer references `yunote_classes`.

**Why this is its own task, not folded into Task 7:** `yunoteSyncStore.ts`'s `deleteAllClassesForUserStmt` is prepared once at store-construction time (`db.prepare(...)` throws immediately for a nonexistent table) — meaning that after Task 6 drops `yunote_classes`, *every* call to `createYunoteSyncStore` anywhere in the codebase would throw at construction, not just `deleteAllForUser`. This is the most severe of the three production dependencies found in spec §8, and is kept as its own small, easy-to-verify task rather than bundled into the larger Task 7 rewrite.

- [ ] **Step 1: Confirm the existing test already exercises this path**

Task 7 Step 1 already updated `'purges organization and classes with a replica without touching the other user'` to drop its `addClass` calls and its `yunote_classes` table check — that test already covers `deleteAllForUser` working correctly without any class data present. No new test is needed here; this task's verification is that the suite still passes after the source change, and — more importantly — that `createYunoteSyncStore` doesn't throw at construction anymore once Task 6 has actually dropped the table.

- [ ] **Step 2: Remove the class-purge statement**

In `src/auth/yunoteSyncStore.ts`:
- Delete `const deleteAllClassesForUserStmt = db.prepare('DELETE FROM yunote_classes WHERE user_id = ?');` (currently line 132).
- Delete `deleteAllClassesForUserStmt.run(userId);` from inside the `purge` transaction in `deleteAllForUser` (currently line 196).
- Update the comment above the block of `deleteAll*Stmt` declarations (currently lines 121-125) if it enumerates classes among what gets purged — check its exact wording and drop the reference rather than leaving it inaccurate.

- [ ] **Step 3: Run tests to verify everything still passes**

Run: `npx jest test/yunote/snapshot.test.ts test/auth` (or whatever the existing `yunoteSyncStore`-covering test paths are — check for a dedicated `yunoteSyncStore.test.ts` alongside `snapshot.test.ts` and include it if present)
Expected: PASS.

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/auth/yunoteSyncStore.ts
git commit -m "fix(yunote): stop account deletion from purging a dropped table

deleteAllClassesForUserStmt prepared a DELETE against yunote_classes
at store-construction time -- with that table gone, every call to
createYunoteSyncStore would have thrown immediately, not just account
deletion specifically. Nothing left to purge server-side once the
table doesn't exist.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 9: Client-side enrollment hash drops `classes` to match

**Files:**
- Modify: `yuNote/src/sync/installationEnrollment.ts`
- Test: `yuNote/test/sync/installationEnrollment.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `localSnapshotJson`'s (internal, unexported) output shape drops `classes`, matching Task 7's server-side `readSnapshot` shape — both sides of the enrollment conflict check (spec §8) must hash the same shape, or every enrollment against an account with existing cloud data would spuriously report a conflict.

**This task is in the yuNote repo, not cloud-platform** — it's the client-side half of Task 7's fix, and must ship together with it (spec §8): a mismatched hash shape between client and server breaks enrollment in the opposite direction from a missing table (a false `snapshot_conflict` on every enrollment, instead of a crash).

- [ ] **Step 1: Check the existing test for a hash-shape assertion**

Read `test/sync/installationEnrollment.test.ts` for any test asserting the exact JSON shape `localSnapshotJson` hashes (it's an internal, unexported function, so a test may instead assert on the `snapshotHash` sent in the request body, or may not cover the exact shape at all — check before assuming which). If such an assertion exists and includes `classes`, update it to match Step 2's change, following the same pattern as this plan's other tasks: a concrete, run-and-verify change, not a guess.

- [ ] **Step 2: Remove `classes` from `localSnapshotJson`**

In `src/sync/installationEnrollment.ts`:
- Delete the `const classes = (await db.execute('SELECT id,name,rev,...'))...` line (currently line 36).
- Remove `classes` from the returned object on line 41 (`return JSON.stringify({schemaVersion:1,classes,notes,lists,listItems});` → `return JSON.stringify({schemaVersion:1,notes,lists,listItems});`).

- [ ] **Step 3: Run tests to verify they pass**

Run: `npx jest test/sync/installationEnrollment.test.ts`
Expected: PASS.

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/sync/installationEnrollment.ts test/sync/installationEnrollment.test.ts
git commit -m "fix(sync): drop classes from the enrollment snapshot hash

Matches cloud-platform's readSnapshot after removing classes from the
snapshot schema (sync-boundary-fix spec §8) -- both sides of the
enrollment conflict check must hash the same shape, or every
enrollment against an account with existing cloud data would report a
spurious conflict.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:** §3.1 (mixed-operation fix) → Task 1. §3.2 (`runLocalOnlyTransaction` + migrating class-only operations + the `deleteClass` guard) → Tasks 2-3. §4 (server rejection) → Tasks 4-5. §5 (schema migration) → Task 6. §6 (deployment order) → reflected in task ordering (client tasks 1-3, then server tasks 4-8, with Task 9 — the other client-side piece — placed after Task 7 since it depends on Task 7's shape). §7's test list → covered across Tasks 1-6. §8 (snapshot/enrollment surface, added after the spec's second revision) → Tasks 7-9.

**Placeholder scan:** none — every step has real code, real file paths, real line-number anchors read directly from the current source, not described abstractly. Task 7's test-file step is the one place this plan describes changes per-test rather than pasting a full replacement file (unlike Task 5's equivalent situation) — a deliberate choice given the file's size and how entangled classes are with nearly every test in it, but each item is still a concrete instruction (delete this test and why; remove these lines; change this expected value to that one), not a vague "update accordingly."

**Execution-time amendment (2026-09-17):** Task 1's implementer surfaced a fifth hidden fixture during execution — `test/data/repositoryJournal.test.ts`, missed by every prior survey pass (both the spec's own and this plan's). Task 3 now includes rewriting its two class-touching tests (Step 4), with the exact replacement content worked out and verified against Task 3's actual post-fix behavior before being added here, the same standard as every other task in this plan. Recorded here rather than silently folded in, since it's a real gap this plan shipped with initially, not a refinement.

**Type consistency:** `runLocalOnlyTransaction<T>(db, execute)` signature is identical everywhere it's referenced (Task 2's definition, Task 3's three call sites). `deleteClassInTransaction`'s new `Promise<void>` return type is consistent between Task 3's Step 3 definition and its (absence of) other callers, confirmed by the `grep` result cited in the spec. `renameClass`'s signature (`db, id, name` → `Promise<Class>`) matches what the spec's §4-linked interaction-model addendum describes it will be called with later. `YunoteSnapshot`'s shape after Task 7 (`{schemaVersion, notes, lists, listItems}`) is identical to `localSnapshotJson`'s shape after Task 9 — checked against each other explicitly, since a silent mismatch here is exactly what would cause the spurious-conflict failure mode Task 9's rationale describes.

**Hidden-fixture and hidden-dependency check (the actual substance of this self-review pass, twice over):** this plan's first draft assumed each server task needed one new test added to one file, and its problem statement was limited to the journal-batch path the spec started from. Reading every test file this change could touch surfaced three fixtures using `entityType:'class'` as ordinary test data (Tasks 4-6, described in their own steps). Separately, `grep`-ing every `yunote_classes` reference across the whole server repo — not just files already in scope — surfaced two more real production dependencies with no test-file precedent to lean on: the snapshot/enrollment path (Task 7) and account deletion (Task 8), plus their client-side counterpart (Task 9). Both passes found real things a narrower reading would have missed and shipped broken — account deletion crashing at store-construction time in particular would have been a production incident, not a bug report.
