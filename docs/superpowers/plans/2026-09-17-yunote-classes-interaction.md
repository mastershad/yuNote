# yuNote Classes Interaction Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the long-press-drag-and-drop Classes interaction on yuNote's Notes screen — dragging one note onto another creates a Class, dragging a note onto a Class adds it, and a temporary "All Notes"/Delete target pair lets the user remove or delete while inside a Class — exactly as designed in the approved interaction-model spec, using the data layer's existing `classes`/`class_id` schema with no migration.

**Architecture:** A new `src/interaction/` module (gesture recognition, drop-target hit-testing, and animation, each independently testable and isolated so a later move from `Animated` to Reanimated only touches one file) composed by a `useNoteDrag` state machine that calls a small cross-store coordinator (`src/state/classInteractions.ts`) wrapping three new mixed data-layer operations (`createClassFromNotes`, `addNoteToClass`, `removeNoteFromClass`) plus a class-membership dissolve invariant shared with note deletion. `NotesScreen` gains root/class navigation state and a merged, date-sorted feed of top-level notes and classes.

**Tech Stack:** TypeScript, React Native 0.86 (New Architecture), `react-native-gesture-handler@^3.3.0` (new dependency — see Global Constraints), Zustand, `op-sqlite`, Jest.

**Spec:** `docs/superpowers/specs/2026-09-17-yunote-classes-interaction-design.md`. Read it before starting — this plan does not repeat its rationale, only its concrete tasks. Two things in that spec are stale relative to the codebase as it exists right now (both confirmed by reading the actual current source before writing this plan, not assumed) — session decisions take priority over the older spec text, called out explicitly rather than silently overridden:

1. **§2/§4 describe `renameClass` as something this plan must add.** It already exists (`src/data/classes.ts`, added by the unrelated sync-boundary-fix plan that shipped first) — this plan *uses* it, does not reimplement it.
2. **§2 describes `deleteClass` as reflowing a class's members to `class_id: null` before deleting.** It no longer does — it now rejects deleting a non-empty class outright (same shipped change). This plan's dissolve invariant (Task 2) is what a class actually goes through on its way to zero/one members; explicit whole-class deletion via `deleteClass` is unreachable through this feature's UI, exactly as spec §13 already says.

## Global Constraints

- Only `NoteCard` is a drag source. `ClassCard` is tap-only. This is what makes "drop a Class on a Class" and nested Classes structurally unreachable — do not add drag support to `ClassCard`.
- A persisted `Class` row always has ≥2 member notes. Enforced by a single shared dissolve helper called from both the "remove to root" and "delete" paths — never reimplement this check per call site.
- Class-touching operations that also touch a real note (`createClassFromNotes`, `addNoteToClass`, `removeNoteFromClass`, note deletion that triggers dissolve) go through `runLocalOperation` (`src/data/localOperation.ts`) — the existing class-event filter and dense-sequence fix already handle these correctly with zero changes to that file. Do not add new `runLocalOnlyTransaction` call sites for anything that touches a note or list.
- No schema migration. Every column this feature needs already exists.
- Classes never sync — do not add a `markDirty` call for the `classes` table anywhere in this plan, and do not add a `synced_at` column to it.
- `react-native-gesture-handler` requires a real native rebuild (`./gradlew`), not just a Metro reload, after Task 1 lands.
- All new UI copy is Russian literals, matching the app's current state — no bespoke i18n mechanism (a separate, later task handles localization app-wide).

## File Structure

```
src/data/classes.ts              MODIFY — dissolve invariant, createClassFromNotes,
                                  addNoteToClass, removeNoteFromClass, listClassNoteCounts
src/data/notes.ts                MODIFY — deleteNoteInTransaction calls the dissolve helper
src/state/classesStore.ts        MODIFY — renameClass action, noteCounts slice
src/state/classInteractions.ts   NEW — cross-store coordinator for the 3 mixed operations
src/app/stores.ts                MODIFY — creates/loads/exposes classesStore
App.tsx                          MODIFY — GestureHandlerRootView, classesStore prop
index.js                         MODIFY — gesture-handler import (must be first line)
package.json                     MODIFY — new dependency
src/ui/ClassCard.tsx             NEW — the Class card component
src/ui/ClassViewHeader.tsx       NEW — Back arrow + tap-to-rename header
src/ui/NotesScreen.tsx           MODIFY — root/class navigation, merged feed, drag wiring
src/interaction/dropTargetRegistry.ts  NEW — pure hit-testing
src/interaction/useDraggable.ts        NEW — RNGH gesture wrapper
src/interaction/useDragAnimation.ts    NEW — Animated wrapper
src/interaction/useNoteDrag.ts         NEW — state machine + drop resolution
src/interaction/dragHaptics.ts         NEW — gesture feedback, separate from relay/haptics.ts
```

**Two implementation-detail gaps found while planning, not explicit in the spec — resolved here, not left for an implementer to improvise:**

1. **`ClassCard` needs a member count** (spec §7: `"N заметок"`), but nothing in the spec's data layer (§4) produces one — `Class` itself has no count field, and the root feed only loads *unclassified* notes, never the classified ones a count would need. Task 2 adds `listClassNoteCounts(db)`, a small aggregate query; Task 3 stores it in `classesStore` alongside `classes`, reloaded whenever `classes` reloads.
2. **A stale-assumption no-op (spec §9 #5/#11) can't literally be a silent success.** `runLocalOperation` requires at least one real journaled event per call (both the original `events.length===0` guard and the later `journalSequence===0` guard from the sync-boundary-fix) — a true no-op has zero of either. Resolved by validating *before any write* inside the transaction and throwing a plain, descriptive `Error` if the assumption no longer holds (nothing has been written yet at that point, so the transaction rolls back trivially). `classInteractions.ts` (Task 4) catches any such rejection from all three mixed operations uniformly and treats it exactly like a cancelled drop — no special-casing "stale" versus any other failure. This also means `useNoteDrag` needs no awareness of *why* a drop failed, only *that* it did.

**One deliberate circular import, not an oversight:** `src/data/classes.ts` and `src/data/notes.ts` import from each other (`classes.ts` calls `notes.ts`'s `updateNoteInTransaction`; `notes.ts` calls `classes.ts`'s dissolve helper). This already existed in this exact shape before the sync-boundary-fix plan removed one direction of it (`deleteClassInTransaction` used to call `updateNoteInTransaction` too). Both functions only reference the other module's export inside a function body, never at module-evaluation time, so this is safe in both Metro and Jest's module systems — not a new risk. Reusing `updateNoteInTransaction` (rather than duplicating its rev-bump/`markDirty` logic inline) is the correct call; avoiding the circularity would mean duplicating that logic instead, which is worse.

---

## Task 1: Add `react-native-gesture-handler` and wire it in

**Files:**
- Modify: `package.json`
- Modify: `index.js`
- Modify: `App.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: the `GestureHandlerRootView` wrapper other tasks' gesture code needs to function at all. Nothing else in this plan is testable end-to-end until this lands.

- [ ] **Step 1: Add the dependency**

In `package.json`, add to `dependencies` (alphabetical, matching the existing list's order):

```json
    "react-native-gesture-handler": "^3.3.0",
```

Run: `npm install`
Expected: installs cleanly, `react-native-gesture-handler` appears in `node_modules`.

- [ ] **Step 2: Wire the required first-line import**

In `index.js`, add as the literal first line of the file (before any other import):

```js
import 'react-native-gesture-handler';
```

- [ ] **Step 3: Wrap the app root in `GestureHandlerRootView`**

In `App.tsx`, add the import:

```ts
import { GestureHandlerRootView } from 'react-native-gesture-handler';
```

Wrap the existing root `<View style={styles.safeArea}>` (currently the outermost element returned by `App`, around line 88) so it becomes the child of a `GestureHandlerRootView`:

```tsx
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <View style={styles.safeArea}>
        {/* ...existing children, unchanged... */}
      </View>
    </GestureHandlerRootView>
  );
```

Both the opening and closing tags change; nothing inside the existing `<View style={styles.safeArea}>` block needs to change for this step.

- [ ] **Step 4: Native rebuild and smoke test**

This requires an actual native rebuild, not just a Metro reload — `react-native-gesture-handler` ships native code that must be compiled in.

Run: `cd android && ./gradlew.bat assembleDebug --console=plain` (or `./gradlew assembleDebug` outside Windows)
Expected: `BUILD SUCCESSFUL`.

Run the full JS test suite to confirm nothing broke: `npx jest`
Expected: all existing suites still pass (the app shell test renders `<App>` via `react-test-renderer`, which does not exercise native code, so `GestureHandlerRootView` rendering as a plain view in that environment should not break it — if it does, report as a concern rather than working around it blindly).

If a device is connected (`adb devices`), install and launch to confirm the app still opens normally:
Run: `adb install -r android/app/build/outputs/apk/debug/app-debug.apk && adb shell monkey -p com.yunote.app -c android.intent.category.LAUNCHER 1`
Expected: app opens to the Notes screen as before — this step only proves the native module links correctly and doesn't crash startup; no gesture behavior exists to test yet.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json index.js App.tsx
git commit -m "feat(ui): add react-native-gesture-handler and wire GestureHandlerRootView

Foundation for the Classes drag-and-drop interaction -- RNGH alone,
no Reanimated (spec §3). Native rebuild required; nothing in this
commit changes app behavior yet.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 2: Data layer — dissolve invariant and the three mixed operations

**Files:**
- Modify: `src/data/classes.ts`
- Modify: `src/data/notes.ts`
- Test: `test/data/classes.test.ts`

**Interfaces:**
- Consumes: `runLocalOperation`, `updateNoteInTransaction` (already exported from `notes.ts`).
- Produces:
  - `createClassFromNotes(db: OpSqliteDb, input: { noteAId: string; noteBId: string }): Promise<Class>`
  - `addNoteToClass(db: OpSqliteDb, input: { noteId: string; classId: string }): Promise<Note>`
  - `removeNoteFromClass(db: OpSqliteDb, noteId: string): Promise<Note>`
  - `listClassNoteCounts(db: OpSqliteDb): Promise<Record<string, number>>`
  - `deleteNoteInTransaction`'s existing signature and behavior are unchanged for notes with no class; for a classified note, it now additionally dissolves the class if needed.

- [ ] **Step 1: Write the failing tests**

Add to `test/data/classes.test.ts` (same file, same `describe` block, same `openMigratedDatabase`/`mkdtempSync` setup already there). Two import changes: add a new import line for `notes.ts`, and extend the existing `classes.ts` import line with the four new functions this task adds — the tests below use all of them, so both must be updated or the tests fail on missing imports, not on real assertions:

```ts
import { createClass, deleteClass, renameClass, createClassFromNotes, addNoteToClass, removeNoteFromClass, listClassNoteCounts, listClasses } from '../../src/data/classes';
import { createNote, deleteNote } from '../../src/data/notes';
```

(the first line replaces the file's current `import { createClass, deleteClass, renameClass, listClasses } from '../../src/data/classes';` — same source, four more names.)

```ts
  it('createClassFromNotes groups two unclassified notes into a new class named "Новый класс"', async () => {
    const noteA = await createNote(db, { title: 'Идея', content: 'A' });
    const noteB = await createNote(db, { title: 'Другая идея', content: 'B' });

    const klass = await createClassFromNotes(db, { noteAId: noteA.id, noteBId: noteB.id });

    expect(klass.name).toBe('Новый класс');
    const { rows } = await db.execute('SELECT id,class_id FROM notes ORDER BY id');
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: noteA.id, class_id: klass.id }),
        expect.objectContaining({ id: noteB.id, class_id: klass.id }),
      ]),
    );
  });

  it('createClassFromNotes journals both note upserts (mixed operation, no class event journaled)', async () => {
    const noteA = await createNote(db, { title: 'A', content: '' });
    const noteB = await createNote(db, { title: 'B', content: '' });

    await createClassFromNotes(db, { noteAId: noteA.id, noteBId: noteB.id });

    const events = (await db.execute('SELECT entity_type,entity_id,mutation FROM mutation_journal ORDER BY dataset_revision,sequence')).rows ?? [];
    expect(events.every((e) => e.entity_type !== 'class')).toBe(true);
    // 4 total note-upsert events in this test: one per createNote call (2),
    // plus one per note reassigned to the new class inside createClassFromNotes (2).
    expect(events.filter((e) => e.entity_type === 'note' && e.mutation === 'upsert')).toHaveLength(4);
  });

  it('createClassFromNotes rejects if either note already belongs to a class (stale assumption)', async () => {
    const existing = await createClass(db, 'Существующий');
    const noteA = await createNote(db, { title: 'A', content: '', classId: existing.id });
    const noteB = await createNote(db, { title: 'B', content: '' });

    await expect(createClassFromNotes(db, { noteAId: noteA.id, noteBId: noteB.id })).rejects.toThrow(/already belongs/);

    expect((await listClasses(db)).length).toBe(1); // no orphaned second class created
  });

  it('createClassFromNotes rejects if either note no longer exists', async () => {
    const noteA = await createNote(db, { title: 'A', content: '' });

    await expect(createClassFromNotes(db, { noteAId: noteA.id, noteBId: 'missing' })).rejects.toThrow(/no longer exist/);
  });

  it('createClassFromNotes rejects a note dropped onto itself (same id twice), rather than creating a 1-member class', async () => {
    const noteA = await createNote(db, { title: 'A', content: '' });

    await expect(createClassFromNotes(db, { noteAId: noteA.id, noteBId: noteA.id })).rejects.toThrow(/itself/);

    expect(await listClasses(db)).toEqual([]); // no invariant-violating class left behind
  });

  it('addNoteToClass adds an unclassified note to an existing class and touches the class', async () => {
    const klass = await createClass(db, 'Работа');
    const note = await createNote(db, { title: 'Идея', content: '' });
    const before = klass.updatedAt;

    const updated = await addNoteToClass(db, { noteId: note.id, classId: klass.id });

    expect(updated.classId).toBe(klass.id);
    const reloaded = (await listClasses(db))[0];
    expect(reloaded.rev).toBe(klass.rev + 1);
    expect(reloaded.updatedAt >= before).toBe(true);
  });

  it('addNoteToClass rejects a note that already has a class', async () => {
    const klassA = await createClass(db, 'A');
    const klassB = await createClass(db, 'B');
    const note = await createNote(db, { title: 'Идея', content: '', classId: klassA.id });

    await expect(addNoteToClass(db, { noteId: note.id, classId: klassB.id })).rejects.toThrow(/already belongs/);
  });

  it('the ≥2-member invariant holds via removeNoteFromClass: removing the second-to-last note dissolves the class', async () => {
    const noteA = await createNote(db, { title: 'A', content: '' });
    const noteB = await createNote(db, { title: 'B', content: '' });
    const klass = await createClassFromNotes(db, { noteAId: noteA.id, noteBId: noteB.id });

    const removed = await removeNoteFromClass(db, noteA.id);

    expect(removed.classId).toBeNull();
    const { rows } = await db.execute('SELECT class_id FROM notes WHERE id=?', [noteB.id]);
    expect((rows?.[0] as { class_id: string | null }).class_id).toBeNull(); // auto-dissolved
    expect(await listClasses(db)).toEqual([]);
  });

  it('the ≥2-member invariant holds via deleteNote: deleting the second-to-last note dissolves the class', async () => {
    const noteA = await createNote(db, { title: 'A', content: '' });
    const noteB = await createNote(db, { title: 'B', content: '' });
    await createClassFromNotes(db, { noteAId: noteA.id, noteBId: noteB.id });

    await deleteNote(db, noteA.id);

    const { rows } = await db.execute('SELECT class_id FROM notes WHERE id=?', [noteB.id]);
    expect((rows?.[0] as { class_id: string | null }).class_id).toBeNull();
    expect(await listClasses(db)).toEqual([]);
  });

  it('a class with 3+ members just gets touched (rev bump) when one note is removed, not dissolved', async () => {
    const noteA = await createNote(db, { title: 'A', content: '' });
    const noteB = await createNote(db, { title: 'B', content: '' });
    const klass = await createClassFromNotes(db, { noteAId: noteA.id, noteBId: noteB.id });
    const noteC = await createNote(db, { title: 'C', content: '' });
    await addNoteToClass(db, { noteId: noteC.id, classId: klass.id });

    await removeNoteFromClass(db, noteA.id);

    const remaining = await listClasses(db);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].rev).toBeGreaterThan(klass.rev);
  });

  it('removeNoteFromClass rejects a note that has no class', async () => {
    const note = await createNote(db, { title: 'A', content: '' });

    await expect(removeNoteFromClass(db, note.id)).rejects.toThrow(/not in a class/);
  });

  it('listClassNoteCounts returns member counts keyed by class id', async () => {
    const noteA = await createNote(db, { title: 'A', content: '' });
    const noteB = await createNote(db, { title: 'B', content: '' });
    const klass = await createClassFromNotes(db, { noteAId: noteA.id, noteBId: noteB.id });
    const emptyish = await createClass(db, 'Только что созданный'); // 0 members, valid pre-dissolve-check state

    const counts = await listClassNoteCounts(db);

    expect(counts[klass.id]).toBe(2);
    expect(counts[emptyish.id]).toBeUndefined();
  });
```

Also add to `test/data/notes.test.ts`. Add `createClassFromNotes, listClasses` from `../../src/data/classes` to its imports — both tests below call them, so (unlike the case above) this addition is actually load-bearing, not just a stale instruction to double-check:

```ts
import { createClassFromNotes, listClasses } from '../../src/data/classes';
```

```ts
  it('deleting an unclassified note does not touch any class', async () => {
    const klass = await createClassFromNotes(db, {
      noteAId: (await createNote(db, { title: 'A', content: '' })).id,
      noteBId: (await createNote(db, { title: 'B', content: '' })).id,
    });
    const unrelated = await createNote(db, { title: 'Unrelated', content: '' });

    await deleteNote(db, unrelated.id);

    expect(await listClasses(db)).toEqual([klass]); // untouched -- the dissolve-check branch is a no-op when classId is null
  });

  it('deleting a classified note that leaves the class with 1 member dissolves it (notes.ts entry point)', async () => {
    const noteA = await createNote(db, { title: 'A', content: '' });
    const noteB = await createNote(db, { title: 'B', content: '' });
    await createClassFromNotes(db, { noteAId: noteA.id, noteBId: noteB.id });

    await deleteNote(db, noteA.id);

    expect(await listClasses(db)).toEqual([]);
    const { rows } = await db.execute('SELECT class_id FROM notes WHERE id=?', [noteB.id]);
    expect((rows?.[0] as { class_id: string | null }).class_id).toBeNull();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest test/data/classes.test.ts test/data/notes.test.ts`
Expected: FAIL — `createClassFromNotes`, `addNoteToClass`, `removeNoteFromClass`, `listClassNoteCounts` don't exist yet (import errors).

- [ ] **Step 3: Implement in `src/data/classes.ts`**

Update the top-of-file imports:

```ts
import type { OpSqliteDb, OpSqliteExecutor } from '../db/connection';
import { generateId, nowIso } from './id';
import { runLocalOnlyTransaction, runLocalOperation, type JournalEvent } from './localOperation';
import { updateNoteInTransaction, type Note } from './notes';
```

Add these functions (after the existing `renameClass`, before `listClasses`):

```ts
async function touchClassInTransaction(tx: OpSqliteExecutor, classId: string): Promise<JournalEvent[]> {
  const { rows } = await tx.execute('SELECT * FROM classes WHERE id=?', [classId]);
  if (!rows?.[0]) throw new Error(`Class not found: ${classId}`);
  const existing = toClass(rows[0] as unknown as ClassRow);
  const klass: Class = { ...existing, rev: existing.rev + 1, updatedAt: nowIso() };
  await tx.execute('UPDATE classes SET rev=?,updated_at=? WHERE id=?', [klass.rev, klass.updatedAt, classId]);
  return [{ entityType: 'class', entityId: classId, mutation: 'upsert', payload: klass }];
}

// Called after any operation that can reduce a class's membership, from both
// the "remove to root" and "delete note" paths, so the ≥2-member invariant
// holds regardless of how membership shrank. Returns the events its own
// writes produced (a note-unwrap event, a class delete/touch event, or
// nothing) -- callers splice these into their own combined events array.
async function dissolveClassIfNeededInTransaction(tx: OpSqliteExecutor, classId: string): Promise<JournalEvent[]> {
  const { rows } = await tx.execute('SELECT id FROM notes WHERE class_id=?', [classId]);
  const remaining = (rows ?? []) as unknown as { id: string }[];
  if (remaining.length >= 2) return touchClassInTransaction(tx, classId);
  const events: JournalEvent[] = [];
  if (remaining.length === 1) {
    const unwrapped = await updateNoteInTransaction(tx, remaining[0].id, { classId: null });
    events.push(...unwrapped.events);
  }
  await tx.execute('DELETE FROM classes WHERE id=?', [classId]);
  events.push({ entityType: 'class', entityId: classId, mutation: 'delete' });
  return events;
}

export async function createClassFromNotes(db: OpSqliteDb, input: { noteAId: string; noteBId: string }): Promise<Class> {
  if (input.noteAId === input.noteBId) throw new Error('Cannot create a class from a note and itself');
  const id = generateId();
  const outcome = await runLocalOperation(db, {
    operationId: generateId(),
    request: { action: 'createClassFromNotes', id, noteAId: input.noteAId, noteBId: input.noteBId },
    execute: async (tx) => {
      const { rows: rowsA } = await tx.execute('SELECT class_id FROM notes WHERE id=?', [input.noteAId]);
      const { rows: rowsB } = await tx.execute('SELECT class_id FROM notes WHERE id=?', [input.noteBId]);
      if (!rowsA?.[0] || !rowsB?.[0]) throw new Error('One or both notes no longer exist');
      const classIdA = (rowsA[0] as unknown as { class_id: string | null }).class_id;
      const classIdB = (rowsB[0] as unknown as { class_id: string | null }).class_id;
      if (classIdA !== null || classIdB !== null) throw new Error('One or both notes already belongs to a class');
      const created = await createClassInTransaction(tx, { id, name: 'Новый класс' });
      const updatedA = await updateNoteInTransaction(tx, input.noteAId, { classId: id });
      const updatedB = await updateNoteInTransaction(tx, input.noteBId, { classId: id });
      return { result: created.klass, events: [...created.events, ...updatedA.events, ...updatedB.events] };
    },
  });
  return outcome.result;
}

export async function addNoteToClass(db: OpSqliteDb, input: { noteId: string; classId: string }): Promise<Note> {
  const outcome = await runLocalOperation(db, {
    operationId: generateId(),
    request: { action: 'addNoteToClass', noteId: input.noteId, classId: input.classId },
    execute: async (tx) => {
      const { rows: noteRows } = await tx.execute('SELECT class_id FROM notes WHERE id=?', [input.noteId]);
      if (!noteRows?.[0]) throw new Error(`Note not found: ${input.noteId}`);
      const currentClassId = (noteRows[0] as unknown as { class_id: string | null }).class_id;
      if (currentClassId !== null) throw new Error(`Note ${input.noteId} already belongs to a class`);
      const { rows: classRows } = await tx.execute('SELECT id FROM classes WHERE id=?', [input.classId]);
      if (!classRows?.[0]) throw new Error(`Class not found: ${input.classId}`);
      const updated = await updateNoteInTransaction(tx, input.noteId, { classId: input.classId });
      const touched = await touchClassInTransaction(tx, input.classId);
      return { result: updated.note, events: [...updated.events, ...touched] };
    },
  });
  return outcome.result;
}

export async function removeNoteFromClass(db: OpSqliteDb, noteId: string): Promise<Note> {
  const outcome = await runLocalOperation(db, {
    operationId: generateId(),
    request: { action: 'removeNoteFromClass', noteId },
    execute: async (tx) => {
      const { rows } = await tx.execute('SELECT class_id FROM notes WHERE id=?', [noteId]);
      if (!rows?.[0]) throw new Error(`Note not found: ${noteId}`);
      const classId = (rows[0] as unknown as { class_id: string | null }).class_id;
      if (classId === null) throw new Error(`Note ${noteId} is not in a class`);
      const updated = await updateNoteInTransaction(tx, noteId, { classId: null });
      const dissolveEvents = await dissolveClassIfNeededInTransaction(tx, classId);
      return { result: updated.note, events: [...updated.events, ...dissolveEvents] };
    },
  });
  return outcome.result;
}

export async function listClassNoteCounts(db: OpSqliteDb): Promise<Record<string, number>> {
  const { rows } = await db.execute('SELECT class_id, COUNT(*) as count FROM notes WHERE class_id IS NOT NULL GROUP BY class_id');
  const counts: Record<string, number> = {};
  for (const row of (rows ?? []) as unknown as { class_id: string; count: number }[]) {
    counts[row.class_id] = row.count;
  }
  return counts;
}
```

`dissolveClassIfNeededInTransaction` must also be exported (add `export` to its declaration) — `notes.ts`'s `deleteNoteInTransaction` needs to call it directly (Step 4). This is intentionally exported for that one cross-module call, not for general use outside the data layer — see this plan's file-structure note on the deliberate circular import.

- [ ] **Step 4: Modify `deleteNoteInTransaction` in `src/data/notes.ts`**

Add the import:

```ts
import { dissolveClassIfNeededInTransaction } from './classes';
```

Replace `deleteNoteInTransaction` (currently a 7-line function) with:

```ts
export async function deleteNoteInTransaction(tx:OpSqliteExecutor,id:string):Promise<JournalEvent[]> {
  const { rows }=await tx.execute('SELECT class_id FROM notes WHERE id=?',[id]);
  if (!rows?.length) throw new Error(`Note not found: ${id}`);
  const classId=(rows[0] as unknown as { class_id:string|null }).class_id;
  await tx.execute('DELETE FROM notes WHERE id=?',[id]);
  await markDirty(tx,'note',id,true);
  const events:JournalEvent[]=[{ entityType:'note', entityId:id, mutation:'delete' }];
  if (classId!==null) events.push(...await dissolveClassIfNeededInTransaction(tx,classId));
  return events;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx jest test/data/classes.test.ts test/data/notes.test.ts`
Expected: PASS — all tests in both files.

Run: `npx jest` (full suite) and `npx tsc --noEmit`
Expected: PASS — the circular import between `classes.ts` and `notes.ts` must not break TypeScript's module resolution or Jest's module loading; if it does, that's a real finding to report, not something to route around silently.

- [ ] **Step 6: Commit**

```bash
git add src/data/classes.ts src/data/notes.ts test/data/classes.test.ts test/data/notes.test.ts
git commit -m "feat(classes): add the ≥2-member invariant and the three mixed operations

createClassFromNotes, addNoteToClass, removeNoteFromClass, and a
shared dissolveClassIfNeededInTransaction helper (called from both
removeNoteFromClass and deleteNoteInTransaction) implement the data
layer the drag interaction needs. All three mixed operations go
through the existing runLocalOperation -- its class-event filter and
dense-sequence fix from the sync-boundary-fix plan already handle
them correctly. Also adds listClassNoteCounts for the Class card's
member count, a gap the interaction spec didn't cover at the data
layer.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 3: Store layer — `renameClass`, note counts, and wiring `classesStore` into the app

**Files:**
- Modify: `src/state/classesStore.ts`
- Modify: `src/app/stores.ts`
- Modify: `App.tsx`
- Test: `test/state/classesStore.test.ts`
- Test: `test/ui/appShell.test.tsx`

**Interfaces:**
- Consumes: `renameClass`, `listClassNoteCounts` from Task 2.
- Produces: `classesStore`'s state gains `noteCounts: Record<string, number>` and a `renameClass(id, name): Promise<Class>` action. `AppStores` gains a `classes` field. `NotesScreen` (Task 5) will consume `props.classesStore`.

- [ ] **Step 1: Write the failing tests**

Add to `test/state/classesStore.test.ts` (same file, same setup):

```ts
  it('renameClass updates the slice in place', async () => {
    const store = createClassesStore(db);
    const cls = await store.getState().createClass('Работа');

    const renamed = await store.getState().renameClass(cls.id, 'Проекты');

    expect(renamed.name).toBe('Проекты');
    expect(store.getState().classes.map((c) => c.name)).toEqual(['Проекты']);
  });

  it('loadClasses also loads noteCounts', async () => {
    const store = createClassesStore(db);
    const cls = await store.getState().createClass('Работа');

    await store.getState().loadClasses();

    expect(store.getState().noteCounts).toEqual({});
    // 0 members isn't in the map at all (matches listClassNoteCounts, which
    // only returns classes with at least one member) -- not the same as {[cls.id]: 0}.
    expect(store.getState().noteCounts[cls.id]).toBeUndefined();
  });
```

Add to `test/ui/appShell.test.tsx`'s `fakeStores()` helper, inside the returned object (after `lists`, before `requestSync`):

```ts
  const classes = create(() => ({
    classes: [],
    noteCounts: {},
    loadClasses: jest.fn().mockResolvedValue(undefined),
    createClass: jest.fn(),
    deleteClass: jest.fn(),
    renameClass: jest.fn(),
  }));
```

and add `classes,` to the returned object literal (`return { notes, lists, classes, requestSync:jest.fn(), close: jest.fn() } as unknown as AppStores;`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest test/state/classesStore.test.ts test/ui/appShell.test.tsx`
Expected: FAIL — `renameClass`/`noteCounts` don't exist on the store yet.

- [ ] **Step 3: Implement in `src/state/classesStore.ts`**

Replace the file's contents:

```ts
import { create, type StoreApi, type UseBoundStore } from 'zustand';
import type { OpSqliteDb } from '../db/connection';
import {
  createClass as repoCreateClass,
  deleteClass as repoDeleteClass,
  renameClass as repoRenameClass,
  listClasses,
  listClassNoteCounts,
  type Class,
} from '../data/classes';

interface ClassesState {
  classes: Class[];
  noteCounts: Record<string, number>;
  loadClasses(): Promise<void>;
  createClass(name: string): Promise<Class>;
  deleteClass(id: string): Promise<void>;
  renameClass(id: string, name: string): Promise<Class>;
}

async function loadClassesAndCounts(db: OpSqliteDb): Promise<{ classes: Class[]; noteCounts: Record<string, number> }> {
  const [classes, noteCounts] = await Promise.all([listClasses(db), listClassNoteCounts(db)]);
  return { classes, noteCounts };
}

export function createClassesStore(db: OpSqliteDb): UseBoundStore<StoreApi<ClassesState>> {
  return create<ClassesState>((set) => ({
    classes: [],
    noteCounts: {},
    async loadClasses() {
      set(await loadClassesAndCounts(db));
    },
    async createClass(name) {
      const cls = await repoCreateClass(db, name);
      set(await loadClassesAndCounts(db));
      return cls;
    },
    async deleteClass(id) {
      await repoDeleteClass(db, id);
      set(await loadClassesAndCounts(db));
    },
    async renameClass(id, name) {
      const cls = await repoRenameClass(db, id, name);
      set(await loadClassesAndCounts(db));
      return cls;
    },
  }));
}
```

- [ ] **Step 4: Wire `classesStore` into `src/app/stores.ts`**

Update imports and the `AppStores` interface:

```ts
import { openMigratedDatabase } from '../db/connection';
import { createNotesStore } from '../state/notesStore';
import { createListsStore } from '../state/listsStore';
import { createClassesStore } from '../state/classesStore';
import {createInstallationSync,type InstallationSync} from '../sync/installationSync';

export interface AppStores {
  notes: ReturnType<typeof createNotesStore>;
  lists: ReturnType<typeof createListsStore>;
  classes: ReturnType<typeof createClassesStore>;
  requestSync():void;
  close(): void;
}
```

Update `createAppStores`'s body: create the store and load it alongside notes/lists. Note the notes load also changes here — root-level notes only (`classId: null`), matching spec §5's merged-feed design (Task 5 wires the UI side of this; this task only changes what gets loaded at boot):

```ts
  const notes = createNotesStore(db,requestSync);
  const lists = createListsStore(db,requestSync);
  const classes = createClassesStore(db);

  try {
    await Promise.all([
      notes.getState().loadNotes({ classId: null, sort: 'date-desc' }),
      lists.getState().loadLists(),
      classes.getState().loadClasses(),
    ]);
  } catch (error) {
    db.close();
    throw error;
  }

  return {
    notes,
    lists,
    classes,
    requestSync,
    close: () => db.close(),
  };
```

- [ ] **Step 5: Update `App.tsx`'s resume-from-background effect and pass `classesStore` through**

The `AppState` effect (around line 71-85) currently reloads notes with `lastLoadOptions ?? { sort: 'date-desc' }`. Change the fallback to match the new root-level default, and reload classes alongside:

```ts
  useEffect(() => {
    if (!stores) return;
    const subscription = AppState.addEventListener('change', nextState => {
      if (nextState !== 'active') return;
      const noteOptions = stores.notes.getState().lastLoadOptions ?? { classId: null, sort: 'date-desc' as const };
      void Promise.all([
        stores.notes.getState().loadNotes(noteOptions),
        stores.lists.getState().loadLists(),
        stores.classes.getState().loadClasses(),
      ]).catch(() => {
        // The next explicit screen action will retry; keep the current local view usable.
      });
      stores.requestSync();
    });
    return () => subscription.remove();
  }, [stores]);
```

Pass the store through to `NotesScreen` (its props type changes in Task 5 — for now this just threads the value; `NotesScreen` doesn't consume it until Task 5 lands, so this step alone would be a TypeScript error against the *current* `NotesScreen` signature. Do this step, then immediately do Task 5's Step 3 signature change in the same working session before running `tsc`, OR add the prop now and accept a transient red `tsc` until Task 5 lands if this task is reviewed independently — call out which in your report):

```tsx
              <NotesScreen store={stores.notes} classesStore={stores.classes} palette={palette} />
```

- [ ] **Step 6: Run tests**

Run: `npx jest test/state/classesStore.test.ts test/ui/appShell.test.tsx`
Expected: PASS.

`npx tsc --noEmit` is expected to fail at this point specifically at `App.tsx`'s new `classesStore={stores.classes}` prop (since `NotesScreen` doesn't accept it until Task 5) — confirm the *only* new error is that one prop mismatch, not something else, and note it in your report rather than silently working around it (e.g. do not add the prop to `NotesScreen`'s signature yourself; that's Task 5's job, so the two tasks stay independently reviewable).

- [ ] **Step 7: Commit**

```bash
git add src/state/classesStore.ts src/app/stores.ts App.tsx test/state/classesStore.test.ts test/ui/appShell.test.tsx
git commit -m "feat(classes): wire classesStore into AppStores, add renameClass action

classesStore now loads member counts alongside classes (for the
future Class card), gains a renameClass action, and is created and
exposed by createAppStores like notes/lists already are. Root-level
note loading switches to classId:null, matching the merged root feed
this plan builds toward -- NotesScreen doesn't consume the new prop
yet (Task 5), so tsc will flag that one mismatch until it does.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 4: Cross-store coordinator — `classInteractions.ts`

**Files:**
- Create: `src/state/classInteractions.ts`
- Test: `test/state/classInteractions.test.ts`

**Interfaces:**
- Consumes: `createClassFromNotes`, `addNoteToClass`, `removeNoteFromClass` (Task 2); `notesStore`, `classesStore` (Task 3).
- Produces:
  - `createClassFromNotesAndReload(db, notesStore, classesStore, input): Promise<Class>`
  - `addNoteToClassAndReload(db, notesStore, classesStore, input): Promise<Note>`
  - `removeNoteFromClassAndReload(db, notesStore, classesStore, noteId): Promise<Note>`

  All three: call the data-layer function, then reload both stores against their current `lastLoadOptions`/default state, then return the data-layer result. `useNoteDrag` (Task 9) is the only consumer.

**Why this exists as its own module, not inlined in `NotesScreen`:** all three mixed operations touch both `notes` and `classes` tables, so both stores need reloading after each — without a shared helper, that reload logic would be written three times directly in the drag state machine. This is the one place that "reload-both-stores" pattern lives.

- [ ] **Step 1: Write the failing tests**

Create `test/state/classInteractions.test.ts`:

```ts
import { openMigratedDatabase, type OpSqliteDb } from '../../src/db/connection';
import { createNotesStore } from '../../src/state/notesStore';
import { createClassesStore } from '../../src/state/classesStore';
import { createNote } from '../../src/data/notes';
import { createClassFromNotes } from '../../src/data/classes';
import {
  createClassFromNotesAndReload,
  addNoteToClassAndReload,
  removeNoteFromClassAndReload,
} from '../../src/state/classInteractions';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('classInteractions', () => {
  let dir: string;
  let db: OpSqliteDb;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'yunote-class-interactions-'));
    db = await openMigratedDatabase({ name: 'test.sqlite', location: dir });
  });

  afterEach(() => {
    try { db?.close(); } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('createClassFromNotesAndReload reloads both stores, removing the two notes from the root feed', async () => {
    const notesStore = createNotesStore(db);
    const classesStore = createClassesStore(db);
    const noteA = await createNote(db, { title: 'A', content: '' });
    const noteB = await createNote(db, { title: 'B', content: '' });
    await notesStore.getState().loadNotes({ classId: null, sort: 'date-desc' });
    await classesStore.getState().loadClasses();
    expect(notesStore.getState().notes).toHaveLength(2);

    const klass = await createClassFromNotesAndReload(db, notesStore, classesStore, { noteAId: noteA.id, noteBId: noteB.id });

    expect(notesStore.getState().notes).toHaveLength(0); // both notes are now classified, out of the root feed
    expect(classesStore.getState().classes.map((c) => c.id)).toEqual([klass.id]);
    expect(classesStore.getState().noteCounts[klass.id]).toBe(2);
  });

  it('addNoteToClassAndReload reloads both stores', async () => {
    const notesStore = createNotesStore(db);
    const classesStore = createClassesStore(db);
    const noteA = await createNote(db, { title: 'A', content: '' });
    const noteB = await createNote(db, { title: 'B', content: '' });
    const klass = await createClassFromNotes(db, { noteAId: noteA.id, noteBId: noteB.id });
    const noteC = await createNote(db, { title: 'C', content: '' });
    await notesStore.getState().loadNotes({ classId: null, sort: 'date-desc' });
    await classesStore.getState().loadClasses();

    await addNoteToClassAndReload(db, notesStore, classesStore, { noteId: noteC.id, classId: klass.id });

    expect(notesStore.getState().notes).toHaveLength(0);
    expect(classesStore.getState().noteCounts[klass.id]).toBe(3);
  });

  it('removeNoteFromClassAndReload reloads both stores and reflects auto-dissolve when it happens', async () => {
    const notesStore = createNotesStore(db);
    const classesStore = createClassesStore(db);
    const noteA = await createNote(db, { title: 'A', content: '' });
    const noteB = await createNote(db, { title: 'B', content: '' });
    await createClassFromNotes(db, { noteAId: noteA.id, noteBId: noteB.id });
    await notesStore.getState().loadNotes({ classId: null, sort: 'date-desc' });
    await classesStore.getState().loadClasses();

    await removeNoteFromClassAndReload(db, notesStore, classesStore, noteA.id);

    expect(classesStore.getState().classes).toEqual([]); // dissolved -- only 1 member would have remained
    expect(notesStore.getState().notes.map((n) => n.id).sort()).toEqual([noteA.id, noteB.id].sort());
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest test/state/classInteractions.test.ts`
Expected: FAIL — `src/state/classInteractions.ts` doesn't exist yet.

- [ ] **Step 3: Implement**

Create `src/state/classInteractions.ts`:

```ts
import type { OpSqliteDb } from '../db/connection';
import type { Note } from '../data/notes';
import type { Class } from '../data/classes';
import { createClassFromNotes, addNoteToClass, removeNoteFromClass } from '../data/classes';
import type { createNotesStore } from './notesStore';
import type { createClassesStore } from './classesStore';

type NotesStore = ReturnType<typeof createNotesStore>;
type ClassesStore = ReturnType<typeof createClassesStore>;

async function reloadBoth(db: OpSqliteDb, notesStore: NotesStore, classesStore: ClassesStore): Promise<void> {
  const noteOptions = notesStore.getState().lastLoadOptions ?? { classId: null as string | null, sort: 'date-desc' as const };
  await Promise.all([
    notesStore.getState().loadNotes(noteOptions),
    classesStore.getState().loadClasses(),
  ]);
}

export async function createClassFromNotesAndReload(
  db: OpSqliteDb, notesStore: NotesStore, classesStore: ClassesStore,
  input: { noteAId: string; noteBId: string },
): Promise<Class> {
  const klass = await createClassFromNotes(db, input);
  await reloadBoth(db, notesStore, classesStore);
  return klass;
}

export async function addNoteToClassAndReload(
  db: OpSqliteDb, notesStore: NotesStore, classesStore: ClassesStore,
  input: { noteId: string; classId: string },
): Promise<Note> {
  const note = await addNoteToClass(db, input);
  await reloadBoth(db, notesStore, classesStore);
  return note;
}

export async function removeNoteFromClassAndReload(
  db: OpSqliteDb, notesStore: NotesStore, classesStore: ClassesStore, noteId: string,
): Promise<Note> {
  const note = await removeNoteFromClass(db, noteId);
  await reloadBoth(db, notesStore, classesStore);
  return note;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest test/state/classInteractions.test.ts`
Expected: PASS.

Run: `npx jest` (full suite, minus the known Task 3-pending `tsc` gap) and `npx tsc --noEmit`
Expected: `tsc` still shows exactly the one known `App.tsx`/`NotesScreen` prop mismatch from Task 3, nothing new from this task.

- [ ] **Step 5: Commit**

```bash
git add src/state/classInteractions.ts test/state/classInteractions.test.ts
git commit -m "feat(classes): add classInteractions cross-store coordinator

Wraps the three mixed data-layer operations with a reload of both
notesStore and classesStore, so callers (the drag state machine,
Task 9) never have to remember which stores a given operation
touches.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 5: UI scaffolding — root/class navigation, merged feed, `ClassCard` (tap-only)

**Files:**
- Create: `src/ui/ClassCard.tsx`
- Create: `src/ui/ClassViewHeader.tsx`
- Modify: `src/ui/NotesScreen.tsx`
- Test: `test/ui/notesFlow.test.tsx`
- Test: `test/ui/appShell.test.tsx`
- Create: `test/ui/classesFlow.test.tsx`

**Interfaces:**
- Consumes: `classesStore` (Task 3), `renameClass` action.
- Produces: `NotesScreen`'s props change from `{ store, palette }` to `{ store, classesStore, palette }`. Classes become visible and navigable on the Notes screen; no drag yet — `ClassCard` is tap-only, matching spec §12 step 4's "classes become visible before the highest-risk piece is added."

This task makes `App.tsx`'s Task 3 prop-threading and `tsc` resolve cleanly — do this task expecting to close that gap, not open a new one.

- [ ] **Step 1: Write the failing tests**

Update `test/ui/notesFlow.test.tsx`'s `notesStore()` helper — no change needed there (it's unaffected), but every `<NotesScreen store={model.store as never} palette={...} />` call needs a `classesStore` prop added. Add a helper matching the file's existing style, right after the `notesStore()` function:

```ts
function classesStore(initial: Class[] = []) {
  const createClass = jest.fn(async (name: string) => ({ id: 'c1', name, createdAt: '', updatedAt: '', rev: 1, position: 0 }));
  const deleteClass = jest.fn(async () => undefined);
  const renameClass = jest.fn(async (id: string, name: string) => ({ id, name, createdAt: '', updatedAt: '', rev: 2, position: 0 }));
  const store = create(() => ({
    classes: initial,
    noteCounts: {} as Record<string, number>,
    loadClasses: jest.fn(async () => undefined),
    createClass,
    deleteClass,
    renameClass,
  }));
  return { store, createClass, deleteClass, renameClass };
}
```

Add the import `import type { Class } from '../../src/data/classes';` at the top. Update every `TestRenderer.create(<NotesScreen store={model.store as never} palette={...} />)` call in this file to also pass `classesStore={classesStore().store as never}`.

Create `test/ui/classesFlow.test.tsx`:

```tsx
import React from 'react';
import { create } from 'zustand';
import TestRenderer, { act } from 'react-test-renderer';
import { NotesScreen } from '../../src/ui/NotesScreen';
import { getThemePalette } from '../../src/ui/theme';
import type { Note } from '../../src/data/notes';
import type { Class } from '../../src/data/classes';

function note(overrides: Partial<Note> = {}): Note {
  return {
    id: 'n1', title: 'Заметка', content: '', classId: null, rev: 1, position: 0,
    createdAt: '2026-09-17T08:00:00.000Z', updatedAt: '2026-09-17T08:00:00.000Z',
    ...overrides,
  };
}

function klass(overrides: Partial<Class> = {}): Class {
  return { id: 'c1', name: 'Работа', createdAt: '2026-09-17T07:00:00.000Z', updatedAt: '2026-09-17T09:00:00.000Z', rev: 1, position: 0, ...overrides };
}

function stores(notes: Note[], classes: Class[], noteCounts: Record<string, number> = {}) {
  const notesStore = create(() => ({
    notes, loadNotes: jest.fn(async () => undefined),
    createNote: jest.fn(), updateNote: jest.fn(), deleteNote: jest.fn(),
  }));
  const classesStore = create(() => ({
    classes, noteCounts, loadClasses: jest.fn(async () => undefined),
    createClass: jest.fn(), deleteClass: jest.fn(),
    renameClass: jest.fn(async (id: string, name: string) => ({ ...classes[0], id, name })),
  }));
  return { notesStore, classesStore };
}

describe('NotesScreen: Classes navigation and merged feed', () => {
  it('renders a merged, date-desc-sorted feed of root notes and classes', async () => {
    const older = note({ id: 'n1', title: 'Старая', updatedAt: '2026-09-17T06:00:00.000Z' });
    const newer = klass({ id: 'c1', name: 'Новее', updatedAt: '2026-09-17T09:00:00.000Z' });
    const { notesStore, classesStore } = stores([older], [newer]);

    let tree!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(
        <NotesScreen store={notesStore as never} classesStore={classesStore as never} palette={getThemePalette('light')} />,
      );
    });

    expect(tree.root.findByProps({ testID: 'class-c1' })).toBeTruthy();
    expect(tree.root.findByProps({ testID: 'note-n1' })).toBeTruthy();
  });

  it('tapping a class opens class view, showing only its own notes', async () => {
    const inClass = note({ id: 'n2', classId: 'c1' });
    const { notesStore, classesStore } = stores([], [klass()]);
    // classInClass's loadNotes is called again once the class view opens --
    // simulate that by having loadNotes populate the slice on the second call.
    let callCount = 0;
    (notesStore.getState().loadNotes as jest.Mock).mockImplementation(async () => {
      callCount++;
      if (callCount > 1) notesStore.setState({ notes: [inClass] });
    });

    let tree!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(
        <NotesScreen store={notesStore as never} classesStore={classesStore as never} palette={getThemePalette('light')} />,
      );
    });
    await act(async () => tree.root.findByProps({ testID: 'class-c1' }).props.onPress());

    expect(notesStore.getState().loadNotes).toHaveBeenLastCalledWith({ classId: 'c1', sort: 'date-desc' });
    expect(tree.root.findByProps({ testID: 'class-back' })).toBeTruthy();
    expect(tree.root.findByProps({ testID: 'note-n2' })).toBeTruthy();
  });

  it('back arrow returns to root and reloads the root feed', async () => {
    const { notesStore, classesStore } = stores([], [klass()]);

    let tree!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(
        <NotesScreen store={notesStore as never} classesStore={classesStore as never} palette={getThemePalette('light')} />,
      );
    });
    await act(async () => tree.root.findByProps({ testID: 'class-c1' }).props.onPress());
    await act(async () => tree.root.findByProps({ testID: 'class-back' }).props.onPress());

    expect(tree.root.findByProps({ testID: 'class-c1' })).toBeTruthy();
    expect(notesStore.getState().loadNotes).toHaveBeenLastCalledWith({ classId: null, sort: 'date-desc' });
  });

  it('tapping the class name in class view enters rename mode, saved on submit', async () => {
    const { notesStore, classesStore } = stores([], [klass()]);

    let tree!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(
        <NotesScreen store={notesStore as never} classesStore={classesStore as never} palette={getThemePalette('light')} />,
      );
    });
    await act(async () => tree.root.findByProps({ testID: 'class-c1' }).props.onPress());
    await act(async () => tree.root.findByProps({ testID: 'class-name-label' }).props.onPress());
    await act(async () => tree.root.findByProps({ testID: 'class-name-input' }).props.onChangeText('Проекты'));
    await act(async () => tree.root.findByProps({ testID: 'class-name-input' }).props.onSubmitEditing());

    expect(classesStore.getState().renameClass).toHaveBeenCalledWith('c1', 'Проекты');
  });

  it('a class with a member count shows it, not a content preview', async () => {
    const { notesStore, classesStore } = stores([], [klass({ id: 'c1' })], { c1: 3 });

    let tree!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(
        <NotesScreen store={notesStore as never} classesStore={classesStore as never} palette={getThemePalette('light')} />,
      );
    });

    const card = tree.root.findByProps({ testID: 'class-c1' });
    expect(JSON.stringify(card)).not.toContain('undefined заметок');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest test/ui/notesFlow.test.tsx test/ui/classesFlow.test.tsx test/ui/appShell.test.tsx`
Expected: FAIL — `NotesScreen` doesn't accept `classesStore` yet, renders no `ClassCard`.

- [ ] **Step 3: Create `src/ui/ClassCard.tsx`**

```tsx
import React, { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { Class } from '../data/classes';
import type { ThemePalette } from './theme';

function pluralizeNotes(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return `${count} заметка`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return `${count} заметки`;
  return `${count} заметок`;
}

export function ClassCard(props: {
  klass: Class;
  noteCount: number;
  onPress(): void;
  palette: ThemePalette;
}) {
  const styles = useMemo(() => makeStyles(props.palette), [props.palette]);
  return (
    <Pressable
      testID={`class-${props.klass.id}`}
      onPress={props.onPress}
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}>
      <View style={styles.stackBack2} />
      <View style={styles.stackBack1} />
      <View style={styles.cardAccent} />
      <View style={styles.cardContent}>
        <Text numberOfLines={1} style={styles.cardTitle}>{props.klass.name}</Text>
        <Text style={styles.cardBody}>{pluralizeNotes(props.noteCount)}</Text>
      </View>
    </Pressable>
  );
}

function makeStyles(p: ThemePalette) {
  return StyleSheet.create({
    card: { minHeight: 132, flexDirection: 'row', overflow: 'hidden', borderRadius: 24, borderWidth: 1, borderColor: p.border, backgroundColor: p.surface, elevation: 2, shadowColor: '#000', shadowOpacity: p.mode === 'dark' ? 0.18 : 0.06, shadowRadius: 10, shadowOffset: { width: 0, height: 4 } },
    stackBack1: { position: 'absolute', top: -4, left: 10, right: 10, height: 12, borderRadius: 16, backgroundColor: p.surface, borderWidth: 1, borderColor: p.border, opacity: 0.9 },
    stackBack2: { position: 'absolute', top: -8, left: 22, right: 22, height: 10, borderRadius: 16, backgroundColor: p.surface, borderWidth: 1, borderColor: p.border, opacity: 0.6 },
    cardAccent: { width: 6, backgroundColor: p.accentSecondary },
    cardContent: { flex: 1, paddingHorizontal: 18, paddingVertical: 16 },
    cardTitle: { color: p.text, fontSize: 19, fontWeight: '900' },
    cardBody: { color: p.mutedText, fontSize: 15, lineHeight: 21, marginTop: 7 },
    pressed: { opacity: 0.78, transform: [{ scale: 0.99 }] },
  });
}
```

- [ ] **Step 4: Create `src/ui/ClassViewHeader.tsx`**

```tsx
import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { ThemePalette } from './theme';

export function ClassViewHeader(props: {
  name: string;
  onBack(): void;
  onRename(name: string): void;
  palette: ThemePalette;
}) {
  const styles = useMemo(() => makeStyles(props.palette), [props.palette]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(props.name);

  const commit = () => {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed.length > 0 && trimmed !== props.name) props.onRename(trimmed);
    else setDraft(props.name);
  };

  return (
    <View style={styles.header}>
      <Pressable testID="class-back" accessibilityRole="button" accessibilityLabel="Назад" onPress={props.onBack} hitSlop={12} style={styles.backButton}>
        <Text style={styles.backArrow}>←</Text>
      </Pressable>
      {editing ? (
        <TextInput
          testID="class-name-input"
          value={draft}
          onChangeText={setDraft}
          onSubmitEditing={commit}
          onBlur={commit}
          autoFocus
          style={styles.nameInput}
        />
      ) : (
        <Pressable testID="class-name-label" onPress={() => { setDraft(props.name); setEditing(true); }}>
          <Text style={styles.name}>{props.name}</Text>
        </Pressable>
      )}
    </View>
  );
}

function makeStyles(p: ThemePalette) {
  return StyleSheet.create({
    header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingTop: 24, paddingBottom: 18, gap: 14 },
    backButton: { width: 40, height: 40, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: p.accentSoft },
    backArrow: { color: p.accent, fontSize: 20, fontWeight: '900' },
    name: { color: p.text, fontSize: 28, fontWeight: '900' },
    nameInput: { color: p.text, fontSize: 28, fontWeight: '900', flex: 1, padding: 0, borderBottomWidth: 2, borderBottomColor: p.accent },
  });
}
```

- [ ] **Step 5: Rewrite `src/ui/NotesScreen.tsx`**

Replace the full file:

```tsx
import React, { useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import type { Note } from '../data/notes';
import type { Class } from '../data/classes';
import { createNotesStore } from '../state/notesStore';
import { createClassesStore } from '../state/classesStore';
import { EmptyState, FloatingAddButton, InlineError, ScreenHeader } from './components';
import { ClassCard } from './ClassCard';
import { ClassViewHeader } from './ClassViewHeader';
import { NoteEditor } from './NoteEditor';
import type { ThemePalette } from './theme';

type ScreenState = { view: 'root' } | { view: 'class'; classId: string; className: string };
type FeedItem = { type: 'note'; note: Note } | { type: 'class'; klass: Class };

function mergeRootFeed(notes: Note[], classes: Class[]): FeedItem[] {
  const items: FeedItem[] = [
    ...notes.map((note): FeedItem => ({ type: 'note', note })),
    ...classes.map((klass): FeedItem => ({ type: 'class', klass })),
  ];
  return items.sort((a, b) => {
    const aTime = a.type === 'note' ? a.note.updatedAt : a.klass.updatedAt;
    const bTime = b.type === 'note' ? b.note.updatedAt : b.klass.updatedAt;
    return bTime.localeCompare(aTime);
  });
}

export function NotesScreen(props: {
  store: ReturnType<typeof createNotesStore>;
  classesStore: ReturnType<typeof createClassesStore>;
  palette: ThemePalette;
}) {
  const notes = props.store(state => state.notes);
  const classes = props.classesStore(state => state.classes);
  const noteCounts = props.classesStore(state => state.noteCounts);
  const [screen, setScreen] = useState<ScreenState>({ view: 'root' });
  const [editing, setEditing] = useState<Note | 'new' | null>(null);
  const [error, setError] = useState('');
  const styles = useMemo(() => makeStyles(props.palette), [props.palette]);

  useEffect(() => {
    const loadForScreen = screen.view === 'root'
      ? props.store.getState().loadNotes({ classId: null, sort: 'date-desc' })
      : props.store.getState().loadNotes({ classId: screen.classId, sort: 'date-desc' });
    Promise.all([loadForScreen, props.classesStore.getState().loadClasses()]).catch(loadError => {
      setError(loadError instanceof Error ? loadError.message : 'Не удалось загрузить заметки');
    });
  }, [props.store, props.classesStore, screen]);

  const selectedNote = editing === 'new' || editing === null ? null : editing;
  const feed = screen.view === 'root' ? mergeRootFeed(notes, classes) : null;

  return (
    <View testID="notes-screen" style={styles.screen}>
      {screen.view === 'root' ? (
        <ScreenHeader eyebrow="YUNOTE" title="Заметки" subtitle="Ваши мысли всегда рядом." palette={props.palette} />
      ) : (
        <ClassViewHeader
          name={screen.className}
          onBack={() => setScreen({ view: 'root' })}
          onRename={async (name) => {
            const renamed = await props.classesStore.getState().renameClass(screen.classId, name);
            setScreen({ view: 'class', classId: renamed.id, className: renamed.name });
          }}
          palette={props.palette}
        />
      )}
      {error ? <View style={styles.errorWrap}><InlineError message={error} palette={props.palette} /></View> : null}
      {screen.view === 'root' ? (
        <FlatList
          data={feed as FeedItem[]}
          keyExtractor={item => (item.type === 'note' ? item.note.id : item.klass.id)}
          contentContainerStyle={feed && feed.length ? styles.list : styles.emptyList}
          renderItem={({ item }) =>
            item.type === 'class' ? (
              <ClassCard
                klass={item.klass}
                noteCount={noteCounts[item.klass.id] ?? 0}
                onPress={() => setScreen({ view: 'class', classId: item.klass.id, className: item.klass.name })}
                palette={props.palette}
              />
            ) : (
              <Pressable
                testID={`note-${item.note.id}`}
                onPress={() => setEditing(item.note)}
                style={({ pressed }) => [styles.card, pressed && styles.pressed]}>
                <View style={styles.cardAccent} />
                <View style={styles.cardContent}>
                  <Text numberOfLines={1} style={styles.cardTitle}>{item.note.title || 'Без названия'}</Text>
                  <Text numberOfLines={3} style={styles.cardBody}>{item.note.content || 'Пустая заметка'}</Text>
                  <Text style={styles.cardMeta}>{formatDate(item.note.updatedAt)}</Text>
                </View>
              </Pressable>
            )
          }
          ListEmptyComponent={
            <EmptyState symbol="✎" title="Здесь появятся заметки" body="Сохраните первую мысль — она останется на телефоне." palette={props.palette} />
          }
        />
      ) : (
        <FlatList
          data={notes}
          keyExtractor={item => item.id}
          contentContainerStyle={notes.length ? styles.list : styles.emptyList}
          renderItem={({ item }) => (
            <Pressable
              testID={`note-${item.id}`}
              onPress={() => setEditing(item)}
              style={({ pressed }) => [styles.card, pressed && styles.pressed]}>
              <View style={styles.cardAccent} />
              <View style={styles.cardContent}>
                <Text numberOfLines={1} style={styles.cardTitle}>{item.title || 'Без названия'}</Text>
                <Text numberOfLines={3} style={styles.cardBody}>{item.content || 'Пустая заметка'}</Text>
                <Text style={styles.cardMeta}>{formatDate(item.updatedAt)}</Text>
              </View>
            </Pressable>
          )}
          ListEmptyComponent={
            <EmptyState symbol="✎" title="Класс пуст" body="Перетащите сюда заметку с главного экрана." palette={props.palette} />
          }
        />
      )}
      {screen.view === 'root' ? (
        <FloatingAddButton testID="add-note" label="Добавить заметку" onPress={() => setEditing('new')} palette={props.palette} />
      ) : null}
      <NoteEditor
        visible={editing !== null}
        note={selectedNote}
        palette={props.palette}
        onClose={() => setEditing(null)}
        onSave={async input => {
          if (selectedNote) {
            await props.store.getState().updateNote(selectedNote.id, input);
          } else {
            await props.store.getState().createNote(input);
          }
        }}
        onDelete={selectedNote ? async () => props.store.getState().deleteNote(selectedNote.id) : undefined}
      />
    </View>
  );
}

function formatDate(iso: string): string {
  const value = new Date(iso);
  return Number.isNaN(value.getTime())
    ? ''
    : value.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

function makeStyles(p: ThemePalette) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: p.background },
    list: { paddingHorizontal: 20, paddingBottom: 108, gap: 13 },
    emptyList: { flexGrow: 1 },
    errorWrap: { paddingHorizontal: 24 },
    card: { minHeight: 132, flexDirection: 'row', overflow: 'hidden', borderRadius: 24, borderWidth: 1, borderColor: p.border, backgroundColor: p.surface, elevation: 2, shadowColor: '#000', shadowOpacity: p.mode === 'dark' ? 0.18 : 0.06, shadowRadius: 10, shadowOffset: { width: 0, height: 4 } },
    cardAccent: { width: 6, backgroundColor: p.accent },
    cardContent: { flex: 1, paddingHorizontal: 18, paddingVertical: 16 },
    cardTitle: { color: p.text, fontSize: 19, fontWeight: '900' },
    cardBody: { color: p.mutedText, fontSize: 15, lineHeight: 21, marginTop: 7 },
    cardMeta: { color: p.accent, fontSize: 12, fontWeight: '800', marginTop: 11 },
    pressed: { opacity: 0.78, transform: [{ scale: 0.99 }] },
  });
}
```

Note: the root and class-view `FlatList`s intentionally duplicate the plain note-card `renderItem` (the root one also has the `item.type==='class'` branch; the class-view one doesn't need it, since a class view never contains classes). This is a deliberate, small duplication rather than a shared sub-component at this step — Task 10 (wiring the drag state machine in) touches both render paths anyway to add pickup handling, and factoring a shared `NoteCard` component out is a reasonable follow-up if that step finds the duplication actually costly, not something to preempt here.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx jest test/ui/notesFlow.test.tsx test/ui/classesFlow.test.tsx test/ui/appShell.test.tsx`
Expected: PASS.

Run: `npx jest` (full suite) and `npx tsc --noEmit`
Expected: both fully clean — this closes the Task 3 prop-mismatch gap.

- [ ] **Step 7: Commit**

```bash
git add src/ui/ClassCard.tsx src/ui/ClassViewHeader.tsx src/ui/NotesScreen.tsx test/ui/notesFlow.test.tsx test/ui/appShell.test.tsx test/ui/classesFlow.test.tsx
git commit -m "feat(ui): root/class navigation, merged feed, tap-only ClassCard

Classes are now visible and navigable on the Notes screen: a merged,
date-desc feed of unclassified notes and classes at root, tap to
open a class, back arrow + tap-to-rename inline in class view. No
drag yet -- ClassCard is tap-only, matching the interaction spec's
own staged rollout (classes visible before the highest-risk piece).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 6: `dropTargetRegistry` — pure hit-testing

**Files:**
- Create: `src/interaction/dropTargetRegistry.ts`
- Test: `test/interaction/dropTargetRegistry.test.ts`

**Interfaces:**
- Produces:
  - `createDropTargetRegistry(): DropTargetRegistry`
  - `DropTargetRegistry.register(id: string, rect: Rect): void`
  - `DropTargetRegistry.unregister(id: string): void`
  - `DropTargetRegistry.hitTest(point: { x: number; y: number }): string | null`

No React, no gesture library, no domain knowledge — a plain module, per spec §3.

- [ ] **Step 1: Write the failing tests**

Create `test/interaction/dropTargetRegistry.test.ts`:

```ts
import { createDropTargetRegistry } from '../../src/interaction/dropTargetRegistry';

describe('dropTargetRegistry', () => {
  it('hitTest returns the id of the rect containing the point', () => {
    const registry = createDropTargetRegistry();
    registry.register('a', { x: 0, y: 0, width: 100, height: 100 });
    registry.register('b', { x: 200, y: 0, width: 100, height: 100 });

    expect(registry.hitTest({ x: 50, y: 50 })).toBe('a');
    expect(registry.hitTest({ x: 250, y: 50 })).toBe('b');
  });

  it('hitTest returns null when the point is outside every registered rect', () => {
    const registry = createDropTargetRegistry();
    registry.register('a', { x: 0, y: 0, width: 100, height: 100 });

    expect(registry.hitTest({ x: 500, y: 500 })).toBeNull();
  });

  it('unregister removes a rect from consideration', () => {
    const registry = createDropTargetRegistry();
    registry.register('a', { x: 0, y: 0, width: 100, height: 100 });
    registry.unregister('a');

    expect(registry.hitTest({ x: 50, y: 50 })).toBeNull();
  });

  it('re-registering the same id replaces its rect rather than duplicating it', () => {
    const registry = createDropTargetRegistry();
    registry.register('a', { x: 0, y: 0, width: 100, height: 100 });
    registry.register('a', { x: 200, y: 200, width: 100, height: 100 });

    expect(registry.hitTest({ x: 50, y: 50 })).toBeNull();
    expect(registry.hitTest({ x: 250, y: 250 })).toBe('a');
  });

  it('when two rects overlap, hitTest returns the most recently registered one', () => {
    const registry = createDropTargetRegistry();
    registry.register('a', { x: 0, y: 0, width: 100, height: 100 });
    registry.register('b', { x: 50, y: 50, width: 100, height: 100 });

    expect(registry.hitTest({ x: 75, y: 75 })).toBe('b');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/interaction/dropTargetRegistry.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

Create `src/interaction/dropTargetRegistry.ts`:

```ts
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DropTargetRegistry {
  register(id: string, rect: Rect): void;
  unregister(id: string): void;
  hitTest(point: { x: number; y: number }): string | null;
}

function contains(rect: Rect, point: { x: number; y: number }): boolean {
  return point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;
}

export function createDropTargetRegistry(): DropTargetRegistry {
  const order: string[] = [];
  const rects = new Map<string, Rect>();

  return {
    register(id, rect) {
      if (!rects.has(id)) order.push(id);
      rects.set(id, rect);
    },
    unregister(id) {
      rects.delete(id);
      const index = order.indexOf(id);
      if (index !== -1) order.splice(index, 1);
    },
    hitTest(point) {
      for (let i = order.length - 1; i >= 0; i--) {
        const rect = rects.get(order[i]);
        if (rect && contains(rect, point)) return order[i];
      }
      return null;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest test/interaction/dropTargetRegistry.test.ts`
Expected: PASS, all 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/interaction/dropTargetRegistry.ts test/interaction/dropTargetRegistry.test.ts
git commit -m "feat(interaction): add dropTargetRegistry

Pure hit-testing module -- no React, no gesture library, no domain
knowledge -- per the interaction spec's module boundary (§3).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 7: `useDraggable` — RNGH gesture wrapper

**Files:**
- Create: `src/interaction/useDraggable.ts`
- Test: `test/interaction/useDraggable.test.ts`

**Interfaces:**
- Consumes: `react-native-gesture-handler` (Task 1).
- Produces: `useDraggable(id, callbacks): GestureType` where `callbacks` is `{ onPickUp(id, origin): void; onMove(id, point): void; onDrop(id, point): void; onCancel(id): void }`. Knows nothing about `Animated` or Class data — pure gesture-to-callback translation, per spec §3.

**Testing note, matching spec §10:** real touch timing (long-press duration, pan thresholds) and the actual "yields to scroll" feel are validated manually on a device (Task 12), not simulated here. This task's test verifies the callback wiring is correct given RNGH's own test utilities — not gesture recognition itself.

- [ ] **Step 1: Write the failing test**

Create `test/interaction/useDraggable.test.ts`:

```ts
import { renderHook } from '@testing-library/react-hooks';
import { useDraggable } from '../../src/interaction/useDraggable';

describe('useDraggable', () => {
  it('returns a composed Gesture object (smoke test -- real recognition is validated manually on-device)', () => {
    const callbacks = { onPickUp: jest.fn(), onMove: jest.fn(), onDrop: jest.fn(), onCancel: jest.fn() };
    const origin = jest.fn(() => ({ x: 0, y: 0, width: 100, height: 100 }));

    const { result } = renderHook(() => useDraggable('note-1', origin, callbacks));

    expect(result.current).toBeDefined();
    // RNGH's composed gesture objects don't expose a simple "call onStart"
    // API outside its own native test harness -- verifying the callbacks
    // actually fire on a real long-press+pan is a manual, on-device check
    // (Task 12), not something this hook-level test can simulate honestly.
  });
});
```

If `@testing-library/react-hooks` is not already a dependency, add it as a devDependency (`npm install --save-dev @testing-library/react-hooks`) — check first, since `react-test-renderer` alone (already present) may be sufficient via a small wrapper component instead; use whichever this repo's existing tests already lean toward, and say which you picked in your report.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/interaction/useDraggable.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

Create `src/interaction/useDraggable.ts`:

```ts
import { Gesture } from 'react-native-gesture-handler';
import type { Rect } from './dropTargetRegistry';

export interface DraggableCallbacks {
  onPickUp(id: string, origin: Rect): void;
  onMove(id: string, point: { x: number; y: number }): void;
  onDrop(id: string, point: { x: number; y: number }): void;
  onCancel(id: string): void;
}

const LONG_PRESS_MIN_DURATION_MS = 400;

export function useDraggable(id: string, measureOrigin: () => Rect, callbacks: DraggableCallbacks) {
  const longPress = Gesture.LongPress()
    .minDuration(LONG_PRESS_MIN_DURATION_MS)
    .onStart(() => {
      callbacks.onPickUp(id, measureOrigin());
    });

  const pan = Gesture.Pan()
    .onUpdate((event) => {
      callbacks.onMove(id, { x: event.absoluteX, y: event.absoluteY });
    })
    .onEnd((event, success) => {
      if (success) callbacks.onDrop(id, { x: event.absoluteX, y: event.absoluteY });
    })
    .onFinalize((_event, success) => {
      if (!success) callbacks.onCancel(id);
    });

  // The pan only starts translating the card once the long-press has
  // already activated -- Simultaneous lets both gestures share the same
  // touch stream, and requiring the long-press to activate first (via
  // manualActivation is not needed here since Pan alone, before
  // long-press fires, never drives onMove because nothing has called
  // onPickUp yet to tell useNoteDrag to enter "dragging") is what keeps
  // an ordinary tap or scroll from ever reaching onMove/onDrop.
  return Gesture.Simultaneous(longPress, pan);
}
```

Note in your report: this is a best-effort, standard RNGH composition based on the library's documented API shape. Getting the exact "long-press activates, then pan takes over, and an un-activated long-press never blocks the parent `FlatList`'s native scroll" feel right is the specific thing Task 12's manual device pass exists to validate and, if needed, adjust — don't treat this file's exact gesture wiring as gospel if the on-device feel is wrong; report what you tried and what you'd change.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest test/interaction/useDraggable.test.ts`
Expected: PASS.

Run: `npx tsc --noEmit`
Expected: clean — confirms the RNGH types are used correctly even though runtime gesture behavior isn't unit-tested.

- [ ] **Step 5: Commit**

```bash
git add src/interaction/useDraggable.ts test/interaction/useDraggable.test.ts package.json package-lock.json
git commit -m "feat(interaction): add useDraggable RNGH gesture wrapper

Long-press (400ms) + pan, composed via Gesture.Simultaneous per spec
§3/§6. Pure gesture-to-callback translation -- no Animated, no Class
data. Real touch-timing/scroll-yielding feel is validated manually
on-device (Task 12), not simulated in this test.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 8: `useDragAnimation` — the only file that touches `Animated`

**Files:**
- Create: `src/interaction/useDragAnimation.ts`
- Test: `test/interaction/useDragAnimation.test.ts`

**Interfaces:**
- Produces: `useDragAnimation()` returning `{ style: Animated.WithAnimatedValue<ViewStyle>; playPickUp(): void; playMove(point): void; playDropSuccess(target): Promise<void>; playCancel(): Promise<void>; reset(): void }`. This is the one file a future Reanimated migration replaces — nothing else in `src/interaction/` changes if that happens (spec §3).

- [ ] **Step 1: Write the failing test**

Create `test/interaction/useDragAnimation.test.ts`. Note: Task 7 (already
implemented) established that `@testing-library/react-hooks` is NOT a
dependency of this repo and deliberately chose not to add it, instead
testing hooks via a small wrapper component using `react-test-renderer`
(already a dependency) — see `test/interaction/useDraggable.test.ts` for
the exact pattern. Translate the two tests below to that same
wrapper-component harness rather than using `renderHook`/`act` from
`@testing-library/react-hooks` as literally written; the assertions
themselves are unchanged, only the rendering mechanism:

```ts
import { renderHook, act } from '@testing-library/react-hooks'; // translate to Task 7's react-test-renderer wrapper pattern -- see note above
import { useDragAnimation } from '../../src/interaction/useDragAnimation';

describe('useDragAnimation', () => {
  it('exposes an animated style object and the documented play*/reset methods', () => {
    const { result } = renderHook(() => useDragAnimation());

    expect(result.current.style).toBeDefined();
    expect(typeof result.current.playPickUp).toBe('function');
    expect(typeof result.current.playMove).toBe('function');
    expect(typeof result.current.playDropSuccess).toBe('function');
    expect(typeof result.current.playCancel).toBe('function');
    expect(typeof result.current.reset).toBe('function');
  });

  it('playMove updates position without throwing outside an animation frame', () => {
    const { result } = renderHook(() => useDragAnimation());

    act(() => {
      result.current.playMove({ x: 40, y: 60 });
    });

    // Animated.ValueXY doesn't expose its current numeric value synchronously
    // in a way worth asserting on here -- the meaningful check is that
    // calling it during a render-hook act() doesn't throw, matching how
    // useNoteDrag (Task 9) will call it from a gesture callback.
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/interaction/useDragAnimation.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

Create `src/interaction/useDragAnimation.ts`:

```ts
import { useRef } from 'react';
import { Animated } from 'react-native';

export function useDragAnimation() {
  const position = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;
  const scale = useRef(new Animated.Value(1)).current;
  const opacity = useRef(new Animated.Value(1)).current;

  const playPickUp = () => {
    Animated.timing(scale, { toValue: 0.94, duration: 150, useNativeDriver: true }).start();
    Animated.timing(opacity, { toValue: 0.95, duration: 150, useNativeDriver: true }).start();
  };

  const playMove = (point: { x: number; y: number }) => {
    position.setValue(point);
  };

  const playDropSuccess = (target: { x: number; y: number }): Promise<void> =>
    new Promise((resolve) => {
      Animated.parallel([
        Animated.spring(position, { toValue: target, useNativeDriver: true }),
        Animated.timing(scale, { toValue: 0, duration: 220, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0, duration: 220, useNativeDriver: true }),
      ]).start(() => resolve());
    });

  const playCancel = (): Promise<void> =>
    new Promise((resolve) => {
      Animated.parallel([
        Animated.spring(position, { toValue: { x: 0, y: 0 }, useNativeDriver: true }),
        Animated.spring(scale, { toValue: 1, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 150, useNativeDriver: true }),
      ]).start(() => resolve());
    });

  const reset = () => {
    position.setValue({ x: 0, y: 0 });
    scale.setValue(1);
    opacity.setValue(1);
  };

  return {
    style: {
      transform: [{ translateX: position.x }, { translateY: position.y }, { scale }],
      opacity,
    },
    playPickUp,
    playMove,
    playDropSuccess,
    playCancel,
    reset,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest test/interaction/useDragAnimation.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/interaction/useDragAnimation.ts test/interaction/useDragAnimation.test.ts
git commit -m "feat(interaction): add useDragAnimation (Animated, not Reanimated)

The one file a future Reanimated migration replaces per spec §3 --
public surface is a style object and play*()/reset() methods, no
Animated types leak past this module.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 9: `useNoteDrag` — the state machine and drop resolution

**Files:**
- Create: `src/interaction/useNoteDrag.ts`
- Test: `test/interaction/useNoteDrag.test.ts`

**Interfaces:**
- Consumes: `dropTargetRegistry`, `useDraggable`, `useDragAnimation` (Tasks 6-8); `classInteractions` (Task 4); `notesStore.deleteNote` (already exists).
- Produces: `useNoteDrag(context)` where `context` includes the current screen (`root` | `class`), `db`, `notesStore`, `classesStore`, and returns per-card drag props plus the two temporary-target registration handlers.

This is where the real, fully-testable logic lives — the drop-target → mutation mapping from spec §6, exercised without any gesture library or RN rendering, per spec §10.

- [ ] **Step 1: Write the failing tests**

Create `test/interaction/useNoteDrag.test.ts`. This tests the *drop resolution* function in isolation — a plain function extracted from the hook, not the hook itself, since the mutation-mapping logic (spec §6's table) is what needs unit coverage, not React state transitions:

```ts
import { resolveDrop } from '../../src/interaction/useNoteDrag';

describe('resolveDrop (spec §6 drop-target -> mutation mapping)', () => {
  const calls = () => {
    const createClassFromNotes = jest.fn();
    const addNoteToClass = jest.fn();
    const removeNoteFromClass = jest.fn();
    const deleteNote = jest.fn();
    return { createClassFromNotes, addNoteToClass, removeNoteFromClass, deleteNote };
  };

  it('root: dropping a note on another note creates a class', async () => {
    const fns = calls();
    await resolveDrop({ screen: { view: 'root' }, draggedId: 'n1', targetId: 'n2', targetType: 'note' }, fns);
    expect(fns.createClassFromNotes).toHaveBeenCalledWith({ noteAId: 'n1', noteBId: 'n2' });
  });

  it('root: dropping a note on a class adds it', async () => {
    const fns = calls();
    await resolveDrop({ screen: { view: 'root' }, draggedId: 'n1', targetId: 'c1', targetType: 'class' }, fns);
    expect(fns.addNoteToClass).toHaveBeenCalledWith({ noteId: 'n1', classId: 'c1' });
  });

  it('root: dropping a note on the delete zone deletes it', async () => {
    const fns = calls();
    await resolveDrop({ screen: { view: 'root' }, draggedId: 'n1', targetId: 'delete-zone', targetType: 'delete' }, fns);
    expect(fns.deleteNote).toHaveBeenCalledWith('n1');
  });

  it('root: dropping on nothing (targetId null) does nothing', async () => {
    const fns = calls();
    await resolveDrop({ screen: { view: 'root' }, draggedId: 'n1', targetId: null, targetType: null }, fns);
    expect(fns.createClassFromNotes).not.toHaveBeenCalled();
    expect(fns.addNoteToClass).not.toHaveBeenCalled();
    expect(fns.deleteNote).not.toHaveBeenCalled();
  });

  it('class view: dropping on the delete zone deletes the note', async () => {
    const fns = calls();
    await resolveDrop({ screen: { view: 'class', classId: 'c1' }, draggedId: 'n1', targetId: 'delete-zone', targetType: 'delete' }, fns);
    expect(fns.deleteNote).toHaveBeenCalledWith('n1');
  });

  it('class view: dropping on the "All Notes" zone removes the note from the class', async () => {
    const fns = calls();
    await resolveDrop({ screen: { view: 'class', classId: 'c1' }, draggedId: 'n1', targetId: 'all-notes-zone', targetType: 'all-notes' }, fns);
    expect(fns.removeNoteFromClass).toHaveBeenCalledWith('n1');
  });

  it('class view: dropping on another note in the same class is invalid -- no mutation', async () => {
    const fns = calls();
    await resolveDrop({ screen: { view: 'class', classId: 'c1' }, draggedId: 'n1', targetId: 'n2', targetType: 'note' }, fns);
    expect(fns.createClassFromNotes).not.toHaveBeenCalled();
    expect(fns.addNoteToClass).not.toHaveBeenCalled();
  });

  it('a rejected mutation (e.g. stale assumption) does not throw out of resolveDrop -- caller treats it as a cancelled drop', async () => {
    const fns = calls();
    fns.createClassFromNotes.mockRejectedValue(new Error('One or both notes already belongs to a class'));

    await expect(
      resolveDrop({ screen: { view: 'root' }, draggedId: 'n1', targetId: 'n2', targetType: 'note' }, fns),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest test/interaction/useNoteDrag.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

Create `src/interaction/useNoteDrag.ts`. Only `resolveDrop` is exercised directly by the tests above; the rest of the file (the actual hook, wired to `dropTargetRegistry`/`useDraggable`/`useDragAnimation`/`classInteractions`) is consumed by `NotesScreen` in Task 10:

```ts
import { useRef, useState } from 'react';
import type { OpSqliteDb } from '../db/connection';
import { createDropTargetRegistry, type Rect } from './dropTargetRegistry';
import { useDraggable } from './useDraggable';
import { useDragAnimation } from './useDragAnimation';
import { createClassFromNotesAndReload, addNoteToClassAndReload, removeNoteFromClassAndReload } from '../state/classInteractions';
import type { createNotesStore } from '../state/notesStore';
import type { createClassesStore } from '../state/classesStore';

type Screen = { view: 'root' } | { view: 'class'; classId: string };
type TargetType = 'note' | 'class' | 'delete' | 'all-notes' | null;

interface DropResolutionFns {
  createClassFromNotes(input: { noteAId: string; noteBId: string }): Promise<unknown>;
  addNoteToClass(input: { noteId: string; classId: string }): Promise<unknown>;
  removeNoteFromClass(noteId: string): Promise<unknown>;
  deleteNote(noteId: string): Promise<unknown>;
}

// Spec §6's drop-target -> mutation table, as a pure function. Exported
// separately from the hook so it's testable without React or a gesture
// library -- this is the actual decision logic; everything else in this
// file is plumbing that calls it.
export async function resolveDrop(
  drop: { screen: Screen; draggedId: string; targetId: string | null; targetType: TargetType },
  fns: DropResolutionFns,
): Promise<void> {
  if (drop.targetId === null || drop.targetType === null) return; // cancel -- nothing to do

  try {
    if (drop.screen.view === 'root') {
      if (drop.targetType === 'note') { await fns.createClassFromNotes({ noteAId: drop.draggedId, noteBId: drop.targetId }); return; }
      if (drop.targetType === 'class') { await fns.addNoteToClass({ noteId: drop.draggedId, classId: drop.targetId }); return; }
      if (drop.targetType === 'delete') { await fns.deleteNote(drop.draggedId); return; }
      return; // any other targetType at root is invalid -- cancel
    }
    // class view
    if (drop.targetType === 'delete') { await fns.deleteNote(drop.draggedId); return; }
    if (drop.targetType === 'all-notes') { await fns.removeNoteFromClass(drop.draggedId); return; }
    return; // note-on-note-in-same-class, or anything else -- invalid, cancel
  } catch {
    // A rejected mutation (stale assumption, concurrent change -- spec §9
    // #5/#11) degrades to exactly the same outcome as an invalid drop: the
    // object snaps back, nothing changes, no error surfaces to the user.
    return;
  }
}

export function useNoteDrag(context: {
  db: OpSqliteDb;
  notesStore: ReturnType<typeof createNotesStore>;
  classesStore: ReturnType<typeof createClassesStore>;
  screen: Screen;
}) {
  const registry = useRef(createDropTargetRegistry()).current;
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const animation = useDragAnimation();

  const fns: DropResolutionFns = {
    createClassFromNotes: (input) => createClassFromNotesAndReload(context.db, context.notesStore, context.classesStore, input),
    addNoteToClass: (input) => addNoteToClassAndReload(context.db, context.notesStore, context.classesStore, input),
    removeNoteFromClass: (noteId) => removeNoteFromClassAndReload(context.db, context.notesStore, context.classesStore, noteId),
    deleteNote: (noteId) => context.notesStore.getState().deleteNote(noteId),
  };

  function registerTarget(id: string, rect: Rect) { registry.register(id, rect); }
  function unregisterTarget(id: string) { registry.unregister(id); }

  function targetTypeFor(id: string): TargetType {
    if (id === 'delete-zone') return 'delete';
    if (id === 'all-notes-zone') return 'all-notes';
    // Root-level note vs. class ids are disambiguated by the caller when
    // registering (NotesScreen knows which id belongs to which card type),
    // so a plain id lookup here would need that map too -- Task 10 passes
    // the resolved type in explicitly via a small id->type map alongside
    // the registry rather than re-deriving it here.
    return null;
  }

  function useDragForNote(noteId: string, measureOrigin: () => Rect, idToType: (id: string) => TargetType) {
    return useDraggable(noteId, measureOrigin, {
      onPickUp: () => { setDraggingId(noteId); animation.playPickUp(); },
      onMove: (_id, point) => animation.playMove(point),
      onDrop: async (_id, point) => {
        const targetId = registry.hitTest(point);
        const targetType = targetId ? (idToType(targetId) ?? targetTypeFor(targetId)) : null;
        if (targetId && targetType) {
          await animation.playDropSuccess(point);
          await resolveDrop({ screen: context.screen, draggedId: noteId, targetId, targetType }, fns);
        } else {
          await animation.playCancel();
        }
        animation.reset();
        setDraggingId(null);
      },
      onCancel: async () => {
        await animation.playCancel();
        animation.reset();
        setDraggingId(null);
      },
    });
  }

  return { draggingId, animation, registerTarget, unregisterTarget, useDragForNote };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest test/interaction/useNoteDrag.test.ts`
Expected: PASS, all 8 `resolveDrop` tests.

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/interaction/useNoteDrag.ts test/interaction/useNoteDrag.test.ts
git commit -m "feat(interaction): add useNoteDrag state machine and drop resolution

resolveDrop implements spec §6's full drop-target -> mutation table as
a pure, independently-tested function; a rejected mutation (stale
assumption, spec §9) degrades to the same outcome as an invalid drop
rather than surfacing an error. The hook composes dropTargetRegistry,
useDraggable, useDragAnimation, and classInteractions -- wired into
NotesScreen in the next task.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 10: Wire the drag state machine into `NotesScreen`

**Files:**
- Modify: `src/ui/NotesScreen.tsx`
- Modify: `src/ui/ClassCard.tsx` (hover-reaction styling only)
- Modify: `src/interaction/useNoteDrag.ts` (add `hoveredTargetId` state — see
  the exact diff in Step 3; Task 9's shipped hook does not track hover, so
  this task must add it, not just consume it)
- Test: `test/ui/classesFlow.test.tsx`

**Interfaces:**
- Consumes: `useNoteDrag` (Task 9) as it exists today: `{ draggingId, animation, registerTarget, unregisterTarget, useDragForNote }` — no `hoveredTargetId` yet.
- Produces: pickup/drag/drop visuals on every `NoteCard`, temporary Delete (root and class view) and "All Notes" (class view only) targets that render only while a drag is in progress, and `ClassCard`'s hover reaction when a dragged note is over it.

This is the highest-risk task in the plan — the piece spec §3/§12 explicitly flags for on-device iteration. Get the wiring structurally correct here; treat exact timing/feel as provisional until Task 12.

- [ ] **Step 1: Write the failing tests**

Add to `test/ui/classesFlow.test.tsx`:

```ts
  it('a drag in progress shows the Delete target at root, hidden otherwise', async () => {
    const { notesStore, classesStore } = stores([note({ id: 'n1' })], []);

    let tree!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(
        <NotesScreen store={notesStore as never} classesStore={classesStore as never} palette={getThemePalette('light')} />,
      );
    });

    expect(tree.root.findAllByProps({ testID: 'drag-delete-zone' })).toHaveLength(0);
  });

  it('inside a class, dragging shows both "All Notes" and Delete targets', async () => {
    const { notesStore, classesStore } = stores([], [klass()]);
    let tree!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(
        <NotesScreen store={notesStore as never} classesStore={classesStore as never} palette={getThemePalette('light')} />,
      );
    });
    await act(async () => tree.root.findByProps({ testID: 'class-c1' }).props.onPress());

    // Neither temporary target occupies layout space until a drag starts --
    // this asserts the resting (non-dragging) state renders neither.
    expect(tree.root.findAllByProps({ testID: 'drag-delete-zone' })).toHaveLength(0);
    expect(tree.root.findAllByProps({ testID: 'drag-all-notes-zone' })).toHaveLength(0);
  });
```

(A full pickup→hover→drop integration test through real gesture events isn't practical via `react-test-renderer`, per Task 7/9's own testing notes — these two tests cover what's mechanically verifiable: the temporary targets are absent at rest, matching the product requirement against permanent chrome. Pickup/drop behavior itself is exercised at the `resolveDrop` level (Task 9) and manually on-device (Task 12).)

- [ ] **Step 2: Run tests to verify they fail (or pass vacuously, then confirm intent)**

Run: `npx jest test/ui/classesFlow.test.tsx`
Expected: both new tests already pass against the current (Task 5) `NotesScreen`, since it renders no drag UI at all yet — this is expected; they exist to *stay* green once drag UI is added, catching a regression where a temporary target accidentally renders unconditionally. Confirm this by reading the diff after Step 3, not by expecting RED here.

- [ ] **Step 3: Wire `useNoteDrag` into `NotesScreen`**

In `src/ui/NotesScreen.tsx`, add the import and instantiate the hook (needs `db` — thread it through as a new prop from `App.tsx`, since `useNoteDrag`'s `classInteractions` calls need it directly, not just via the stores):

```ts
import { useNoteDrag } from '../interaction/useNoteDrag';
import type { OpSqliteDb } from '../db/connection';
```

Add `db: OpSqliteDb` to `NotesScreen`'s props type. In `App.tsx`, this means threading the database handle out of `createAppStores` — add `db` to `AppStores` (`db: OpSqliteDb`) alongside the existing fields, and pass `db={stores.db}` to `NotesScreen`. (`src/app/stores.ts` already has the `db` value in scope inside `createAppStores`; add it to the returned object.)

Inside `NotesScreen`, after the existing state declarations:

```ts
  const drag = useNoteDrag({
    db: props.db,
    notesStore: props.store,
    classesStore: props.classesStore,
    screen: screen.view === 'root' ? { view: 'root' } : { view: 'class', classId: screen.classId },
  });
```

For each note card (both the root feed's note branch and the class-view list), replace the plain `Pressable` with an `Animated.View` wrapping a gesture-detector view driven by `drag.useDragForNote(item.note.id, measureOrigin, idToType)`, where `idToType` resolves an id to `'note' | 'class' | null` from the currently-rendered feed (root) or always `'note'` (class view, since only notes are ever listed there). Unregister on unmount via a cleanup effect, matching `dropTargetRegistry`'s documented contract (Task 6).

**Coordinate space — register every target in window-absolute coordinates,
not `onLayout`'s raw `event.nativeEvent.layout`.** `useDraggable`'s pan
(Task 7) reports `event.absoluteX`/`absoluteY` — real window coordinates.
`onLayout`'s `layout` is parent-relative and, inside a `FlatList`, doesn't
track scroll offset. Registering raw `layout` values against a
window-absolute hit-test point means `dropTargetRegistry.hitTest` will
silently miss or hit the wrong target as soon as any header/scroll offset
exists — i.e. in essentially all real usage. Use a ref + `measureInWindow`
for every `registerTarget` call site (note cards, root-feed `ClassCard`s,
and both temporary zones below), the same pattern `measureOrigin` already
needs for pickup-origin measurement:

```ts
const zoneRef = useRef<View>(null);
// ...
onLayout={() => {
  zoneRef.current?.measureInWindow((x, y, width, height) => {
    drag.registerTarget('delete-zone', { x, y, width, height });
  });
}}
```

Add the two temporary targets, rendered only when `drag.draggingId !== null`:

```tsx
{drag.draggingId !== null ? (
  <View
    ref={deleteZoneRef}
    testID="drag-delete-zone"
    onLayout={() => {
      deleteZoneRef.current?.measureInWindow((x, y, width, height) => {
        drag.registerTarget('delete-zone', { x, y, width, height });
      });
    }}
    style={styles.deleteZone}>
    <Text style={styles.deleteZoneLabel}>🗑 Удалить</Text>
  </View>
) : null}
{drag.draggingId !== null && screen.view === 'class' ? (
  <View
    ref={allNotesZoneRef}
    testID="drag-all-notes-zone"
    onLayout={() => {
      allNotesZoneRef.current?.measureInWindow((x, y, width, height) => {
        drag.registerTarget('all-notes-zone', { x, y, width, height });
      });
    }}
    style={styles.allNotesZone}>
    <Text style={styles.allNotesZoneLabel}>↑ Все заметки</Text>
  </View>
) : null}
```

(`deleteZoneRef`/`allNotesZoneRef` are `useRef<View>(null)` declared inside
`NotesScreen`, same pattern as `DraggableNoteCard`'s `cardRef`.)

Add corresponding styles (`deleteZone`, `deleteZoneLabel`, `allNotesZone`, `allNotesZoneLabel`) to `makeStyles`, positioned per spec §6's diagram (bottom for delete, top for "All Notes", both fixed/absolute so they don't shift list layout when they appear).

**First, add hover tracking to `src/interaction/useNoteDrag.ts`** (Task 9's
shipped hook computes `registry.hitTest(point)` inside `onDrop` but never
during `onMove`, and exposes no hover state at all — this task needs both).
Apply this exact diff:

```diff
   const registry = useRef(createDropTargetRegistry()).current;
   const [draggingId, setDraggingId] = useState<string | null>(null);
+  const [hoveredTargetId, setHoveredTargetId] = useState<string | null>(null);
   const animation = useDragAnimation();
```

```diff
       onPickUp: () => { setDraggingId(noteId); animation.playPickUp(); },
-      onMove: (_id, point) => animation.playMove(point),
+      onMove: (_id, point) => {
+        animation.playMove(point);
+        setHoveredTargetId(registry.hitTest(point));
+      },
       onDrop: async (_id, point) => {
         const targetId = registry.hitTest(point);
         const targetType = targetId ? (idToType(targetId) ?? targetTypeFor(targetId)) : null;
         if (targetId && targetType) {
           await animation.playDropSuccess(point);
           await resolveDrop({ screen: context.screen, draggedId: noteId, targetId, targetType }, fns);
         } else {
           await animation.playCancel();
         }
         animation.reset();
         setDraggingId(null);
+        setHoveredTargetId(null);
       },
       onCancel: async () => {
         await animation.playCancel();
         animation.reset();
         setDraggingId(null);
+        setHoveredTargetId(null);
       },
```

```diff
-  return { draggingId, animation, registerTarget, unregisterTarget, useDragForNote };
+  return { draggingId, hoveredTargetId, animation, registerTarget, unregisterTarget, useDragForNote };
```

Give `ClassCard` a `hovered: boolean` prop (default `false`) that applies spec §7's hover styling (`scale: 1.03–1.05`, `backgroundColor: accentSoft`) when true — `NotesScreen` passes `hovered={drag.hoveredTargetId === klass.id}` for each rendered `ClassCard`, using the `hoveredTargetId` state just added above.

- [ ] **Step 4: Run tests**

Run: `npx jest test/ui/classesFlow.test.tsx test/ui/notesFlow.test.tsx`
Expected: PASS — including the two new tests from Step 1, now meaningfully verifying the targets are absent at rest against real drag-aware markup, not just absent because no drag code exists.

Run: `npx jest` (full suite) and `npx tsc --noEmit`
Expected: both clean.

- [ ] **Step 5: Native rebuild and manual smoke check**

Run: `cd android && ./gradlew.bat assembleDebug --console=plain`
Expected: `BUILD SUCCESSFUL`.

If a device is connected, install and launch, and attempt one long-press-and-drag of a note onto another to confirm SOME visible reaction occurs (even if timing/feel isn't polished yet — that's Task 12's job). Report what you observed, including if nothing visibly happens — that's a real finding for Task 12 to start from, not a reason to silently iterate on gesture parameters yourself beyond what this task's brief specifies.

- [ ] **Step 6: Commit**

```bash
git add src/ui/NotesScreen.tsx src/ui/ClassCard.tsx src/interaction/useNoteDrag.ts App.tsx src/app/stores.ts test/ui/classesFlow.test.tsx
git commit -m "feat(ui): wire drag pickup/move/drop into NotesScreen

Every note card is now a drag source via useNoteDrag; Delete and
All-Notes targets render only while a drag is in progress, per the
product requirement against permanent chrome. ClassCard reacts on
hover. Exact gesture feel/timing is provisional pending Task 12's
on-device pass.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 11: Drag haptics

**Files:**
- Create: `src/interaction/dragHaptics.ts`
- Modify: `src/interaction/useNoteDrag.ts`
- Test: `test/interaction/dragHaptics.test.ts`

**Interfaces:**
- Produces: `DragFeedback` interface (`pickup`, `targetEntered`, `dropSuccess`, `deleteSuccess`) and a `Vibration`-based implementation — deliberately separate from `relay/haptics.ts`'s `arrivalPulse` (spec §8: that one is scoped to content arriving from elsewhere, never a gesture the user just performed themselves).

- [ ] **Step 1: Write the failing test**

Create `test/interaction/dragHaptics.test.ts`:

```ts
import { Vibration } from 'react-native';
import { androidDragFeedback } from '../../src/interaction/dragHaptics';

jest.mock('react-native', () => ({ Vibration: { vibrate: jest.fn() } }));

describe('dragHaptics', () => {
  it('each method calls Vibration.vibrate exactly once, with distinct durations for pickup vs. targetEntered', () => {
    androidDragFeedback.pickup();
    androidDragFeedback.targetEntered();
    androidDragFeedback.dropSuccess();
    androidDragFeedback.deleteSuccess();

    expect(Vibration.vibrate).toHaveBeenCalledTimes(4);
    const calls = (Vibration.vibrate as jest.Mock).mock.calls.map((c) => c[0]);
    expect(new Set(calls).size).toBeGreaterThan(1); // not all identical -- pickup should read as distinct from a light hover tick
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/interaction/dragHaptics.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

Create `src/interaction/dragHaptics.ts`:

```ts
import { Vibration } from 'react-native';

/**
 * Feedback for the user's own drag gesture -- distinct from
 * relay/haptics.ts's arrivalPulse, which is scoped to content arriving
 * from elsewhere and must never fire for an action the user just
 * performed themselves (see that file's own doc comment).
 */
export interface DragFeedback {
  pickup(): void;
  targetEntered(): void;
  dropSuccess(): void;
  deleteSuccess(): void;
}

export const androidDragFeedback: DragFeedback = {
  pickup() { Vibration.vibrate(40); },
  targetEntered() { Vibration.vibrate(15); },
  dropSuccess() { Vibration.vibrate(40); },
  deleteSuccess() { Vibration.vibrate(60); },
};
```

- [ ] **Step 4: Wire into `useNoteDrag`**

In `src/interaction/useNoteDrag.ts`, add the import and a `feedback` parameter (default to the real implementation, overridable for tests — matching how `context.db`/stores are already passed in explicitly rather than imported as singletons):

```ts
import { androidDragFeedback, type DragFeedback } from './dragHaptics';
```

Add `feedback: DragFeedback` to `useNoteDrag`'s `context` parameter (with `context.feedback ?? androidDragFeedback` as the effective value used internally, so existing callers that don't pass it keep working). Call `feedback.pickup()` in the `onPickUp` handler, `feedback.targetEntered()` when `hoveredTargetId` transitions from `null`/different to a new valid target id, and `feedback.dropSuccess()` / `feedback.deleteSuccess()` inside `onDrop`'s success branch — `deleteSuccess` specifically when `targetType === 'delete'`, `dropSuccess` for every other successful drop type. No haptic call on the cancel path, matching spec §8/§12's forgiving-silence design.

- [ ] **Step 5: Run tests**

Run: `npx jest test/interaction/dragHaptics.test.ts test/interaction/useNoteDrag.test.ts`
Expected: PASS.

Run: `npx jest` (full suite) and `npx tsc --noEmit`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/interaction/dragHaptics.ts src/interaction/useNoteDrag.ts test/interaction/dragHaptics.test.ts
git commit -m "feat(interaction): add drag haptics, wired to useNoteDrag's transitions

Separate DragFeedback interface from relay/haptics.ts's arrivalPulse
per spec §8 -- gesture feedback for the user's own action, never
content arriving from elsewhere. No haptic on cancel, matching the
forgiving-silence design.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 12: Manual Android device verification

**Files:** none (verification only — may produce follow-up findings that become new, separately-planned tasks, not code changes made silently under this task).

This is the decision point spec §3/§10/§12 all point to for whether the RNGH-alone/`Animated` choice (Task 1's dependency decision) holds up, or needs revisiting toward Reanimated.

- [ ] **Step 1: Native rebuild and install**

Run: `cd android && ./gradlew.bat assembleDebug --console=plain && adb install -r android/app/build/outputs/apk/debug/app-debug.apk`
Expected: builds and installs cleanly.

Start Metro if not already running (`npx react-native start`) and `adb reverse tcp:8081 tcp:8081`, then launch the app.

- [ ] **Step 2: Verify the golden path**

On the device: long-press a note (confirm haptic + visual lift), drag it onto another note (confirm the target reacts, confirm haptic + settle on drop, confirm a Class card now appears in its place), open the class (tap), drag a third note from root onto the open class from a fresh drag, confirm it joins (member count updates), drag a note inside the class onto "All Notes" (confirm it returns to root), drag a note onto the Delete zone both at root and inside a class (confirm deletion + haptic), and drag a note to empty space (confirm it snaps back with no change and no haptic).

- [ ] **Step 3: Verify the auto-dissolve edge case on a real device**

Create a class from two notes, then drag one of them back out via "All Notes" — confirm the class disappears and the remaining note becomes an ordinary root-level note (not a 1-member class), matching spec §9 #1/#2.

- [ ] **Step 4: Assess long-press-vs-scroll feel and overall responsiveness**

Scroll the notes list normally (confirm no accidental pickup), then long-press-and-drag while the list has enough content to scroll (confirm the drag doesn't fight the scroll, and scrolling doesn't accidentally trigger a pickup). Note any dropped frames, laggy finger-tracking, or gesture recognition that feels wrong.

- [ ] **Step 5: Report and decide**

Write findings to a short note in your task report: what worked, what didn't, and specifically whether anything observed meets spec §3's stated trigger for reconsidering Reanimated ("measurable responsiveness or frame-stability problems"). If nothing does, no further action — Option B (RNGH + `Animated`) stands as shipped. If something does, do not silently start adding Reanimated in this task — report it as a finding requiring its own brainstorming/design pass, since spec §3 treats that as a real architectural decision, not a drive-by dependency swap.

No commit for this task unless Step 2-4 surface a small, obviously-scoped bug fix (e.g., a target's hitbox is visibly wrong) — if so, fix it as its own small commit with its own before/after description, separate from the verification report itself.

---

## Self-Review

**Spec coverage:** §3 (gesture/animation stack, module boundary) → Tasks 1, 6-8. §4 (data layer) → Task 2, including the two gaps (note counts, stale-assumption handling) the spec didn't resolve at this level of detail. §5 (navigation, merged feed) → Task 5. §6 (drag architecture, drop resolution table) → Task 9 (`resolveDrop` is spec §6's table verbatim) and Task 10 (wiring). §7 (visual design) → Tasks 5, 10. §8 (haptics) → Task 11. §9 (edge cases) → covered across Task 2's tests (invariant, stale-assumption rejection), Task 9's `resolveDrop` tests (nested/same-class-drop unreachability by construction, matching §6's "only NoteCard drags" decision), and Task 12 (app-backgrounded, on-device only). §10 (testing strategy) → reflected in every task's own test approach, including the explicit "manual, not simulated" calls in Tasks 7 and 12. §11 (dependency/native setup) → Task 1. §12 (implementation order) → this plan's task ordering, refined into 12 concrete tasks from the spec's 7-step sketch.

**Placeholder scan:** none — every task has real code, real file contents (not fragments needing "fill in the rest"), and real test assertions. Task 12 is the one task with no code deliverable by design (a verification pass) and says so explicitly rather than inventing placeholder code for it.

**Type consistency:** `NotesScreen`'s props grow across three tasks (`classesStore` in Task 5, `db` in Task 10) — each addition is a stated, deliberate prop-signature change with its call sites (`App.tsx`) updated in the same task, and Task 3's Step 6 explicitly calls out the one-task transient `tsc` gap this creates rather than hiding it. `resolveDrop`'s `DropResolutionFns` interface (Task 9) matches `classInteractions.ts`'s actual exported function signatures (Task 4) exactly — checked side by side while writing this. `DragFeedback`'s four methods (Task 11) match the spec §8 interface's four names exactly, since the spec explicitly says the names are illustrative but this plan had no reason to deviate from them.

**Scope check:** Notes only, matching spec §1's explicit scope decision — no task touches `lists.class_id`. Localization stays out (spec §1/§13) — all new copy is Russian literals. No task adds Reanimated preemptively (Task 1 installs RNGH alone; Task 12 is the only place that decision can be revisited, and explicitly defers doing so to a separate pass rather than folding it in).

**Ambiguity check:** the two places a spec-literal reading could go wrong were made explicit rather than left to an implementer's guess: (1) whether a stale-assumption "no-op" can coexist with `runLocalOperation`'s ≥1-event invariant (it can't as a literal no-op — resolved as "throw, caller treats as cancel," stated in the file-structure notes and built into `resolveDrop`'s own try/catch); (2) how a Class card's member count is obtained at all, which the spec's data-layer section never designs (resolved with `listClassNoteCounts`, `classesStore.noteCounts`, stated as a found gap rather than silently added).
