# yuNote Classes Sync-Boundary Fix — Design

## 1. Motivation

While designing the Classes interaction model
(`2026-09-17-yunote-classes-interaction-design.md`), inspecting the exact
shape of journal events the new data-layer operations would need to emit
surfaced a pre-existing violation of a principle both that spec and the
original `2026-09-07-yunote-local-app-design.md` §3 state explicitly:
*"Classes are never transmitted to Key Fob/AI... the data physically
never enters the sync code path."*

In reality, today:

- `src/data/classes.ts`'s `createClassInTransaction`/`deleteClassInTransaction`
  already emit `entityType:'class'` journal events (with the class's
  `name` in the payload) into `mutation_journal`.
- `src/sync/journalUploader.ts` reads `mutation_journal` with no
  `entity_type` filter and uploads every row it finds, including these.
- `cloud-platform/src/yunote/journalBatchValidator.ts` and
  `journalBatchStore.ts` were built to deliberately accept and persist
  class payloads — `yunote_classes` (with `name`) and
  `yunote_note_organization`/`yunote_list_organization` (with `class_id`)
  are real, working server-side tables, not an oversight in a filter.

This is confirmed, not suspected — read directly from both the client and
server source. Checked against production: `yunote_classes` currently has
**zero rows**, so there is no data to clean up, only a mechanism to fix
before Classes actually get used.

**Product direction, confirmed 2026-09-17:** Classes are a purely local,
per-device organizational convenience, not a thing that should ever sync.
This spec's job is making that true structurally, not just in
documentation.

This is a sync-boundary correctness fix, independent of the Classes
interaction/UI work. It touches an already-deployed, signed wire protocol
shared between the yuNote client and `cloud-platform`, and is designed
and shipped as its own change — the interaction-model spec does not
depend on it landing first, and this spec does not depend on the UI work
landing at all.

## 2. Why a naive filter doesn't work

The obvious fix — exclude `entity_type='class'` rows wherever they're
read for upload — breaks the wire protocol, confirmed by reading
`journalBatchValidator.ts` directly:

```ts
// journalBatchValidator.ts, per-revision check:
if (sequence === 0) throw new Error('batch revision has no events');
// per-event check, inside the same loop:
if (event.sequence !== sequence++) throw new Error('batch event sequence is not contiguous');
```

The server requires (a) every revision in the declared range to have at
least one event, and (b) each revision's event `sequence` values to be
exactly `0, 1, 2, ...` with no gaps. `mutation_journal`'s schema
(`PRIMARY KEY (dataset_revision, sequence)`) doesn't itself require
contiguous sequence numbers, but the wire protocol the server validates
does. A filter applied after the fact — at write time in
`runLocalOperation`, or at read time in `journalUploader` — would either
produce revisions with zero events (rejected by check (a)) or
non-contiguous sequences (rejected by check (b)), for any operation whose
journaled events are entirely or partially class-typed.

The fix has to account for both checks by construction, not by filtering
after the numbers are already assigned.

## 3. Client fix — two cases, not one

Class-touching operations split into two shapes with different fixes,
because they interact with the sync boundary differently.

### 3.1 Mixed operations (touch both a class and a note)

`createClassFromNotes`, `addNoteToClass`, `removeNoteFromClass`, and
note-deletion-triggering-dissolve all produce a mix of `class`- and
`note`-typed journal events from one `runLocalOperation` call. These
*do* need a `dataset_state.revision` bump — the note-side change is real,
synchronized data. The fix is entirely inside
`runLocalOperation`'s (`src/data/localOperation.ts`) event-insertion
loop: skip the `INSERT INTO mutation_journal` step for any event where
`entityType === 'class'`, and assign the `sequence` column from a counter
that only advances for events actually inserted — not from the source
array's index.

```ts
// Current (src/data/localOperation.ts, inside runLocalOperation):
for (let sequence=0; sequence<executed.events.length; sequence++) {
  const event=executed.events[sequence];
  // ...validation...
  await tx.execute(`INSERT INTO mutation_journal (...,sequence,...) VALUES (...)`, [...,sequence,...]);
}

// Fixed:
let journalSequence=0;
for (let index=0; index<executed.events.length; index++) {
  const event=executed.events[index];
  // ...same validation, unchanged...
  if (event.entityType==='class') continue; // Classes are outside the
    // synchronized dataset boundary -- never written to mutation_journal,
    // regardless of what else the same local operation touched.
  await tx.execute(`INSERT INTO mutation_journal (...,sequence,...) VALUES (...)`, [...,journalSequence,...]);
  journalSequence++;
}
```

The **invariant** this establishes: journaled `sequence` reflects the
order of *journaled* events, never the index into the original local
event array. This must hold regardless of where in the array the class
event falls — `[class, note]` and `[note, class, note]` both produce
densely-numbered `0..N-1` sequences for whatever actually gets journaled
(§7 covers both as explicit test cases). Nothing in `journalUploader.ts`
or the server needs to change for this case — the fix is fully contained
in how `mutation_journal` gets written.

### 3.2 Pure class-only operations

`renameClass` (new) and the existing `createClass`/`deleteClass` are
operations where *every* emitted event is class-typed. §3.1's fix would
leave these with a bumped `dataset_state.revision` and zero
`mutation_journal` rows for it — reintroducing exactly the "revision with
no events" gap §2 describes, this time client-side in
`journalUploader`'s own gap check before a request is even sent.

The correct framing, not a workaround: **Classes are outside the
synchronized dataset boundary.** A local operation whose effect is
entirely local therefore has no business touching the machinery that
exists specifically to synchronize the dataset —
`dataset_state.revision`, `mutation_journal`, `applied_operations`. It
shouldn't participate in that machinery at all, rather than participate
and then have its participation suppressed.

`src/data/localOperation.ts` gains a second, much smaller helper
alongside `runLocalOperation`:

```ts
export async function runLocalOnlyTransaction<T>(
  db: OpSqliteDb,
  execute: (tx: OpSqliteExecutor) => Promise<T>,
): Promise<T> {
  let result: T | undefined;
  await db.transaction(async (tx) => {
    result = await execute(tx);
  });
  return result as T;
}
```

This is deliberately not a second journal system and doesn't imitate
`runLocalOperation`'s shape (no `operationId`, no idempotency ledger, no
events). Its only job is to name the boundary explicitly at each call
site — "this transaction is local-only by design" — rather than have bare
`db.transaction()` calls scattered through `classes.ts` with the reason
left implicit. `renameClass`, `createClass`, and `deleteClass` all move
onto it.

**Trade-off, stated precisely:** these operations lose
`runLocalOperation`'s idempotency-replay protection (duplicate execution
under the same `operationId` is no longer detected and short-circuited).
This is an accepted consequence of Classes being outside the
synchronized boundary that protection exists for, not a claim that
duplicate execution has no effect — a duplicate `createClass` still
creates a second, real, visible class row a user would have to notice and
delete. The mitigation is UI-level (§9 of the interaction-model spec's
busy-flag convention, already designed to prevent double-fire from rapid
repeated interaction), not a data-layer replay guarantee.

**`createClass`/`deleteClass` call sites, checked directly:** `grep` for
callers outside their own definitions and the untouched `classesStore`
wrapper returns nothing — no UI code calls either function today, and
the Classes interaction-model spec's own §13 confirms neither is part of
its planned UI (creation goes through `createClassFromNotes`; deletion
only ever happens through the dissolve invariant). They're migrated onto
`runLocalOnlyTransaction` anyway — not to design replay semantics for
dead API, but because leaving them on `runLocalOperation` would keep them
inconsistent with the invariant this fix establishes for the rest of the
file, for no benefit to any real caller. This is a reduction in surface
(one local-only path for the whole module), not new design work.

**`deleteClass` needed one more fact before it could move, found while
planning this task:** `deleteClassInTransaction` currently reflows any
member notes/lists to `classId: null` before deleting the class row —
meaning its emitted events are conditionally mixed (class + note/list) or
conditionally pure (class only), depending on whether the class happened
to have members at call time. Neither §3.1's fix nor a flat move to
`runLocalOnlyTransaction` handles both shapes correctly: an empty-class
delete routed through `runLocalOperation` would still hit the "revision
with nothing journaled" gap from §2, since §3.1's fix only densifies
sequences when *something* survives the class-event filter.

Resolved by an explicit product rule (confirmed 2026-09-17, and now
recorded as the source of truth in the interaction-model spec's §13
addendum): **a class cannot be deleted while it still has member
notes** — the only way out of membership is the dissolve invariant,
which already guarantees a class never sits at 1 member. Enforcing this
as a guard in `deleteClassInTransaction` (reject deletion if any
note/list still references the class, instead of reflowing them) makes
`deleteClass` unconditionally pure class-only — there is no longer a
data-dependent shape to handle, and it moves onto
`runLocalOnlyTransaction` exactly like `createClass` and `renameClass`,
no special-casing needed. This guard is a Class-domain rule owned by the
interaction-model spec (see its §4/§13), not a sync-boundary concern —
it's implemented as part of this plan only because it's this fix's
prerequisite for `deleteClass` specifically, not because this spec
claims the rule.

## 4. Server fix — explicit rejection, not silent tolerance

`cloud-platform/src/yunote/journalBatchValidator.ts`: remove `'class'`
from `TYPES` and the `type==='class'` branch from `payloadFor`. Any
`entityType:'class'` event reaching the server — from a stale client
build, a bug, or anything else — fails validation with a clear error
(`entityType is invalid`) and the batch is rejected outright, the same
way any other malformed event is handled today. Nothing about this
introduces silent dropping of an unexpected event; it makes an
unexpected event explicitly not the server's problem to store.

`cloud-platform/src/yunote/journalBatchStore.ts`: remove the
`case 'class':` branch, `upsertClass`, and `deleteMap.class` — the server
no longer has a code path that could persist a class payload even if one
somehow validated.

The server no longer understands "Class" as a synchronized entity at
all, matching the client-side boundary in §3.

## 5. Schema migration

`yunote_classes` is dropped. `yunote_note_organization` and
`yunote_list_organization` keep their `class_id` column (still needed —
§ below) but lose the `FOREIGN KEY (user_id, class_id) REFERENCES
yunote_classes(user_id, id)` constraint, since its target is going away.
`class_id` becomes an ordinary opaque `TEXT` column the server never
interprets or joins against.

Both `schema.sql` (fresh installs) and a new idempotent migration
function in `cloud-platform/src/db/db.ts` (existing installs) need this,
following the established `migrateServiceConnectionsNullable` pattern —
recreate-with-copy under an explicit transaction, since SQLite has no
`ALTER TABLE DROP CONSTRAINT`:

```ts
function migrateYunoteDropClassSync(db: Database.Database): void {
  if (!tableExists(db, 'yunote_classes')) return; // already migrated
  const migrate = db.transaction(() => {
    // Recreate the two organization tables WITHOUT the FK to
    // yunote_classes first -- foreign_keys=ON means dropping yunote_classes
    // while either table still declares that FK would leave a dangling
    // reference the moment either table is next written to.
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
  // structural change -- adding it here specifically because this
  // migration recreates two FK-bearing tables under foreign_keys=ON and a
  // silent dangling reference would only surface later, as an opaque
  // write failure on some unrelated note/list update. New precedent, not
  // an established one.
  const violations = db.pragma('foreign_key_check') as unknown[];
  if (violations.length > 0) {
    throw new Error(`Post-migration foreign key check found ${violations.length} violation(s)`);
  }
}
```

This is proven safe under exactly the conditions that matter, not just
the empty-table case: non-empty `*_organization` tables, rows with `NULL`
`class_id`, rows with non-`NULL` `class_id` (defensive — current
production data should be all-`NULL` since no class has ever existed to
reference, but the migration doesn't assume that), and existing
`position` values, all carried through the `INSERT ... SELECT` untouched,
verified by `PRAGMA foreign_key_check` immediately after.

Registered in `openDatabase()` alongside the other `migrateYunote*`
calls, after `migrateYunoteInstallationKeyRotation`.

## 6. Deployment order

Client change ships first (stops producing class journal events), then
server (stops accepting/storing them, runs the schema migration). This
ordering — rather than something more elaborate for staged rollout — is
correct specifically because there is no production installed base of
yuNote clients that would need backward-compatible handling during a
transition window: this is a pre-production, single-developer app. If
that ever stops being true, this ordering decision needs revisiting
alongside it.

## 7. Testing strategy

**Client (`test/data/localOperation.test.ts`, `test/data/classes.test.ts`):**
- A class-only mutation (`renameClass`, `createClass`, `deleteClass` on an
  empty class) does not change `dataset_state.revision`.
- A class-only mutation produces zero rows in `mutation_journal`.
- `deleteClass` rejects deletion of a class that still has a member note
  or list, rather than reflowing them (§3.2's new guard) — this replaces
  the existing `test/data/classes.test.ts` case that currently asserts
  the opposite (deleting a class with a member note succeeds and nulls
  its `class_id`); that test's expectation is now wrong on purpose and
  gets updated, not just extended.
- A **synthetic** mixed operation (a test-only `execute()` callback
  passed directly to `runLocalOperation`, not a real repository
  function) with events `[class, note]` journals only the note event, at
  `sequence=0`.
- The same synthetic approach with events `[note, class, note]` journals
  both note events, at `sequence=0` and `sequence=1` — proving the
  invariant is "sequence reflects journaled order," not "sequence skips
  index N," which the two-event case alone can't distinguish.
- Synthetic, not real, because no real mixed-shaped operation
  (`createClassFromNotes`, `addNoteToClass`, `removeNoteFromClass`, or
  dissolve-triggering note deletion) exists in the codebase yet — those
  are the interaction-model spec's own data-layer tasks, not this plan's.
  **When that plan implements them, its own tests must include this same
  check against the real functions** — this spec's synthetic tests prove
  the mechanism works, not that every future caller uses it correctly.

**Server (`cloud-platform/test/yunote/journalBatchValidator.test.ts`, `journalBatchStore.test.ts`, `db.test.ts`):**
- `entityType: 'class'` is rejected by the validator with an explicit error, not silently dropped.
- No code path in `journalBatchStore` can persist a class payload (the `case 'class':` branch no longer exists to test around).
- Migration preserves existing `yunote_note_organization`/`yunote_list_organization` rows, including both `NULL` and non-`NULL` `class_id` values and existing `position` values.
- Migration passes `PRAGMA foreign_key_check` with zero violations afterward.
- A freshly-created database (via `schema.sql` alone) has no `yunote_classes` table and no FK from either organization table to it.

## 8. What this spec does not settle

- **The Classes interaction/UI work itself** — that's
  `2026-09-17-yunote-classes-interaction-design.md`, a separate,
  independent change. This spec doesn't block it and isn't blocked by it.
- **`note.class_id`/`list.class_id` syncing in general** — confirmed
  2026-09-17 to stay as-is; only the `classes` table itself and its FK
  leave the sync boundary.
- **Any staged/backward-compatible rollout strategy** — explicitly not
  needed per §6; would need to be revisited if that premise ever changes.

## Self-Review Notes

- **Placeholder scan:** none.
- **Internal consistency:** §3.1's "sequence reflects journaled order"
  invariant and §7's two mixed-operation test cases (`[class,note]` and
  `[note,class,note]`) are the same claim stated twice at different
  levels — design and verification — checked against each other while
  writing this rather than asserted independently.
- **Scope check:** deliberately narrow — sync-boundary correctness only,
  kept separate from the interaction-model spec per explicit instruction
  (§8). The one crossing is §3.2's `deleteClass` guard, which is a
  Class-domain rule (owned by the interaction-model spec, amended there)
  rather than a sync-boundary rule — implemented here only because it's
  this fix's own prerequisite, called out explicitly rather than left to
  look like scope creep.
- **Ambiguity check:** §3.2's rationale for moving `createClass`/
  `deleteClass` was the one place most likely to be read as "adding
  replay semantics to dead code" rather than the intended "removing
  inconsistency from already-dead code, at lower cost than leaving it
  alone" — made explicit rather than left to infer, including the actual
  `grep` check that established they have no real call sites today.
