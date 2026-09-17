# yuNote Classes Interaction Model — Design

## 1. Motivation

`yuNote`'s Notes screen currently has no way to organize notes beyond a
flat, date-sorted list. Product requirements for a lightweight grouping
mechanism called "Classes" — behaving like an Android home-screen folder,
created purely by dragging one note onto another, with no menus, no
"Move to folder" dialogs, no checkboxes — were established in the same
discussion that produced this spec and are treated here as settled, the
same way `2026-09-07-yunote-local-app-design.md` treats its own product
requirements as settled instead of re-deriving them.

This is not new ground: `docs/superpowers/specs/2026-09-07-yunote-local-app-design.md`
§5 already designed a version of this exact interaction (long-press/pan
gesture racing against scroll, drag-note-onto-note to create a class,
cancel-safe rollback) and laid down the `classes` table and `class_id`
columns for it. `docs/superpowers/specs/2026-09-12-yunote-working-local-ui-design.md`
then explicitly deferred it out of the first shippable UI: *"Classes
remain in the database architecture but are deferred from this first UI
because the intended long-press and drag interaction needs its own
focused implementation."* This spec is that focused implementation. It
supersedes 2026-09-07 §5 where the two disagree (see §3 and §4) and
otherwise reuses what 2026-09-07 already got right.

**Scope decision: Notes only, not Lists.** The current schema gives both
`notes` and `lists` a `class_id` column, which goes further than
2026-09-07 §3 originally scoped ("Lists have no `class_id`... nothing
calls for classifying Lists"). For this version, Classes apply only to
Notes on the Notes screen, matching the original product requirement.
`lists.class_id` remains present and unused by this feature — a future
scope decision, not a data model change, if Lists ever need it.

**Forward reference — localization.** All UI copy in this spec (default
class name, target labels) is Russian, matching the app's current
Russian-only prototype state. The next planned yuNote task after this one
adds OS-locale detection and auto-applies it to the app's own copy. This
spec does not implement that, and deliberately keeps new strings as
ordinary literals rather than inventing a bespoke string-table mechanism
of its own — the localization task will move all of the app's existing
strings, including the ones this spec adds, in one pass.

## 2. What already exists (not being redesigned)

The local data layer for Classes is materially already built:

- `classes` table (`id`, `name`, `created_at`, `updated_at`, `rev`,
  `position`) and `class_id` on both `notes` and `lists`.
- `src/data/classes.ts`: `createClass`, `deleteClass` (already reflows
  contained notes/lists back to `class_id: null` before deleting the
  row), `listClasses`.
- `src/state/classesStore.ts`: reactive `classes` slice with
  `loadClasses`/`createClass`/`deleteClass`.
- `src/data/notes.ts` / `src/state/notesStore.ts`: `classId` is already a
  first-class field on `Note`, `listNotes` already filters by
  `classId`/`null`/all, `updateNote` already reassigns `classId`.
- Schema migrations are current through version 6; no migration adds
  anything this feature needs.

None of this is replaced. This spec designs only what's missing:
insertion into an existing class, the grouping-into-a-new-class
operation, rename, removal-with-auto-dissolve, and the entire UI/gesture
layer, which currently has zero presence (`grep` for `class`/`classId`
across `src/ui/` returns nothing).

## 3. Gesture and animation stack

**Chosen: `react-native-gesture-handler` (RNGH) alone, driving React
Native's built-in `Animated` API. No `react-native-reanimated`, no
`react-native-worklets`.**

2026-09-07 §2/§5 assumed RNGH + Reanimated as a pair without evaluating
alternatives. Checking current reality changes the picture:

- `react-native-gesture-handler@3.3.0` is New-Architecture-only as of
  3.0 (legacy architecture support was dropped) — yuNote already runs
  `newArchEnabled=true`, so this is a clean fit, not a constraint.
- `react-native-reanimated@4.6.0` requires RN `0.83–0.87` (yuNote is on
  0.86.0 — compatible) but 4.x split its worklets runtime into a new
  mandatory peer, `react-native-worklets@0.12.x`, with its own Babel
  plugin (`react-native-worklets/plugin`, not the old
  `react-native-reanimated/plugin`). That's two new native modules plus
  a Babel config change, not one.
- RNGH 3.0's new hook-based API explicitly supports React Native's
  built-in `Animated` API; Reanimated/SharedValue integration is an
  optional performance enhancement, not a hard dependency of RNGH 3.x.

RNGH alone still solves the one genuinely hard problem here — long-press
recognition that correctly yields to list scrolling
(`Gesture.LongPress()` raced against `Gesture.Pan()` via
`Gesture.Race()`) — which is why a gesture library is needed at all
(hand-rolled `PanResponder` composition for this exact race is a known
source of flaky scroll/long-press interaction and is rejected for that
reason). `Animated` with `useNativeDriver: true` is enough for the
motion this feature needs (translate-follow, scale, opacity, spring
settle) at the scale of a handful of on-screen cards.

**Migration path is kept open on purpose.** The interaction/animation
code is isolated into its own module boundary so a later move to
Reanimated touches one file, not the Class domain model or the gesture
recognition wiring:

```
src/interaction/
  useDraggable.ts       — wraps RNGH: long-press+pan gesture, exposes
                           onPickUp/onMove/onDrop/onCancel callbacks.
                           Knows nothing about Animated or Class data.
  dropTargetRegistry.ts — pure module: registers/unregisters measured
                           layout rects by id (via onLayout), exposes
                           hitTest(point) -> targetId | null. No React,
                           no gesture library, no domain knowledge.
  useDragAnimation.ts   — the only file that touches `Animated`. Its
                           public surface is style objects and
                           play*() methods. This is what a future
                           Reanimated migration replaces; nothing else
                           in this list changes.
```

Class domain operations (§4) receive only "note X dropped on target Y"
and never see gesture or animation state. `NotesScreen` composes
`useDraggable` + `dropTargetRegistry` + `useDragAnimation` into the state
machine in §6, but none of those three modules depend on each other or
on `NotesScreen`.

**Trigger for revisiting this decision:** measurable responsiveness or
frame-stability problems found during on-device testing (§10). Not
adopted preemptively.

## 4. Data layer changes

Two of the required interactions already work with zero new code, since
`updateNote(db, noteId, {classId})` already exists:

- Adding a note to an *existing* class = `updateNote(db, noteId,
  {classId: targetClassId})`.
- Opening a class = `listNotes(db, {classId: klass.id, sort:
  'date-desc'})`.

What's new, all following the existing `*InTransaction` +
`runLocalOperation` pattern already used throughout `src/data/`:

**`renameClass(db, id, name)`** — same shape as `updateNoteInTransaction`:
patches `name`, bumps `rev`/`updated_at`.

**`createClassFromNotes(db, {noteAId, noteBId})`** — one
`runLocalOperation` transaction: `createClassInTransaction` (name
defaults to "Новый класс" — no naming dialog before creation, per
product requirement; renaming afterward is cheap via the above) +
`updateNoteInTransaction` on both notes with the new `classId`. Before
writing, it re-reads both notes inside the transaction and requires both
to currently have `classId: null`; if either doesn't (a concurrent
change invalidated the drag's assumption — see §9), the operation is a
no-op rather than corrupting an unrelated class.

**Invariant: a persisted `Class` row always has ≥ 2 member notes.** This
single rule is the resolution for two of the edge cases in §9 ("class
left with 1 note" and "last note removed from class"). A shared internal
helper, `dissolveClassIfNeededInTransaction(tx, classId)`, is called
after any operation that can reduce a class's membership, and counts
remaining members:

- 0 remaining → delete the `classes` row (defensive; shouldn't occur if
  the ≥2 invariant held going in).
- 1 remaining → clear that note's `classId` and delete the `classes`
  row (auto-dissolve).
- ≥2 remaining → bump the class's own `updated_at`/`rev` only, so it
  re-sorts in the merged feed (§5) the same way an edited note would.

This helper is called from two entry points, so the invariant holds
regardless of *how* membership shrank:

- **`removeNoteFromClass(db, noteId)`** (new) — the "All Notes" target's
  operation: `updateNoteInTransaction(noteId, {classId: null})` then
  `dissolveClassIfNeededInTransaction(tx, theOldClassId)`.
- **`deleteNoteInTransaction`** (existing function, modified) — if the
  note being deleted had a non-null `classId`, call
  `dissolveClassIfNeededInTransaction` after the delete. This applies
  uniformly to deletion via the drag Delete-target *and* deletion via
  the existing note editor's delete flow — the invariant shouldn't
  depend on which UI path triggered the deletion.

**`addNoteToClass(db, {noteId, classId})`** — `updateNoteInTransaction
(noteId, {classId})` + a small `touchClassInTransaction(tx, classId)`
(bumps `updated_at`/`rev` only) so the class re-sorts on membership
change the same way it does on creation.

**No schema migration required** — every column this needs already
exists (§2); the last migration is version 6.

**Sync boundary is unchanged and must stay unchanged in the new code
too:** `classes` has no `synced_at` and none of the new functions call
`markDirty` for the `classes` table — Classes never enter the sync path,
per the existing security boundary (`class_id` is stripped from
AI-facing reads server-side; the client-side half of that boundary is
that Classes physically never get marked dirty). `notes.class_id`
changes already flow through `markDirty` via the existing
`updateNoteInTransaction`/`deleteNoteInTransaction` — no change needed
there.

## 5. Navigation and the merged root feed

Two states for `NotesScreen`, held as local component state — no
navigation library, matching the pattern `App.tsx` already uses for its
own two-tab state (`2026-09-12` spec explicitly rejected adding React
Navigation before it's needed; the same reasoning applies here):

```ts
type NotesScreenState = { view: 'root' } | { view: 'class'; classId: string; className: string };
```

**Root view.** `notesStore.loadNotes({classId: null, sort: 'date-desc'})`
(top-level, unclassified notes only) and `classesStore.loadClasses()`
load independently as they do today. A UI-layer selector merges the two
already-loaded slices and sorts by `updatedAt` across both — this is a
plain function in `NotesScreen`, not a new cross-aggregate repository
method, keeping the one-module-per-aggregate convention `src/data/`
already follows. Each merged item renders as a `NoteCard` or `ClassCard`
depending on type. This is why §4's `touchClassInTransaction` and the
dissolve helper's "≥2, just touch" branch matter: without them, a class
whose membership just changed wouldn't move in this sort the way an
edited note does.

**Class view.** Header: Back arrow (returns to `{view: 'root'}`) + class
name, tap-to-edit inline in place (a plain text input swapped in for the
label, saved on blur/submit via `renameClass`) — no separate settings
screen. Body: `listNotes({classId: klass.id, sort: 'date-desc'})`,
already fully supported.

Classes are one level deep only. There is no Class-view-within-a-Class;
§6 and §9 explain why nesting can't be reached through the interaction
model rather than needing to be explicitly blocked.

## 6. Drag interaction architecture

**Only `NoteCard` is a drag source.** `ClassCard` is tap-only (opens the
class) in this version. This single decision is what makes "drop a Class
onto a Class" and "nested Classes" unreachable rather than cases that
need runtime rejection (§9).

**State machine** (implemented via `useNoteDrag`, composing the three
`src/interaction/` modules from §3):

```
idle → longPressed (haptic + pickup visual)
     → dragging (follows finger; temporary drop targets visible)
     → hover(targetId) (target reacts)
     → drop (commit mutation)  |  cancel (snap back, no mutation)
```

**Drop resolution, by screen and target:**

*Root view:*
| Dropped on | Result |
|---|---|
| Another `NoteCard` | `createClassFromNotes` |
| A `ClassCard` | `addNoteToClass` |
| Delete zone (bottom, visible during drag) | `deleteNote` |
| Anything else | cancel |

*Class view:*
| Dropped on | Result |
|---|---|
| Delete zone (bottom) | `deleteNote` (dissolve invariant applies automatically if this brings the class to ≤1) |
| "All Notes" zone (top, visible only inside a class during drag) | `removeNoteFromClass` |
| Another note already in the same class | invalid — cancel (they're already grouped; no reordering/nesting semantics exist to give this a meaning) |
| Anything else | cancel |

The Delete and "All Notes" targets are rendered only while a drag is in
progress and never occupy layout space otherwise, per the product
requirement against permanent chrome.

## 7. Visual design — Class-card and animation principles

**`ClassCard` reuses `NoteCard`'s geometry**, not a new visual language:
same `minHeight`, `borderRadius`, shadow/elevation as the existing `card`
style in `NotesScreen.tsx`. Differences, using tokens already defined in
`theme.ts`:

- `cardAccent` left bar uses `accentSecondary` (violet) instead of
  `accent` (blue) — a cheap, already-on-brand way to distinguish a class
  from a note without redesigning the card (matches the mascot's
  "electric blue to violet accents" visual system already documented in
  the 2026-09-12 spec).
- No content preview (a class has none); its place is taken by an item
  count ("N заметок").
- A restrained "stack" cue — two offset rounded rectangles peeking out
  from behind the card (plain `View`s, negative margin/z-index, no new
  image assets) — gesturing at "contains multiple objects" without
  literally copying the Android launcher icon.
- Tap uses the same `Pressable` pattern already in `NotesScreen`, routing
  to `{view: 'class', ...}` instead of opening the note editor.

**Mechanism:** since §3 chose `Animated` over Reanimated, drag position
updates via `Animated.ValueXY.setValue()` called from RNGH's `onUpdate`
callback (JS thread, once per gesture frame), but every animated style
uses `useNativeDriver: true` so the actual frame-by-frame paint runs on
the UI thread. `useDragAnimation` (§3) is the only place this detail
lives.

**Overlay rendering.** A card inside a `FlatList` can't visually float
above its siblings while staying in list flow. During `dragging`, the
original list item dims in place (opacity ~0.4, stays visible so the
user doesn't lose track of where it came from) while a single absolutely
-positioned `Animated.View` clone, starting from the card's measured
origin, renders above everything and follows the finger. This lives in
`NotesScreen`, not inside `FlatList`'s `renderItem`.

**Timings** (extends the animation vocabulary `NotesScreen.tsx` already
uses for tap feedback — compare to its existing `pressed: {scale:
0.99}`):

| Transition | Effect | Duration |
|---|---|---|
| pickup | scale → 0.94, background → `surfaceRaised`, shadow increases, + haptic | ~150ms ease-out |
| dragging | 1:1 finger-follow, opacity 0.95, no easing | per frame |
| hover over valid target | target scale → 1.03–1.05, background → `accentSoft`, + light haptic on entry | ~120ms |
| drop success | animates into target position and shrinks/fades (create/add), or shrinks/fades at the Delete zone | ~220ms spring + haptic |
| cancel | spring back to original position/scale | ~220ms spring, no haptic |

## 8. Haptics

`src/relay/haptics.ts`'s `HapticFeedback.arrivalPulse()` is explicitly
scoped, by its own doc comment, to content arriving from elsewhere (Key
Fob relay, collaboration inbox) — never for an action the user's own
gesture just caused, since they can already see it happen. Reusing it
for drag feedback would blur that distinction.

A separate, small interface for gesture feedback, following the same
`Vibration`-based approach (no new native haptics dependency):

```ts
interface DragFeedback {
  pickup(): void;
  targetEntered(): void;
  dropSuccess(): void;
  deleteSuccess(): void;
}
```

(Names are illustrative, not binding — the implementation should match
whatever reads most naturally against `useNoteDrag`'s state machine.) No
haptic fires on cancel — silence communicating "nothing happened" matches
the product requirement that invalid drops are fully forgiving.

## 9. Edge cases

| # | Case | Resolution |
|---|---|---|
| 1 | Class left with exactly 1 note | §4's dissolve invariant — atomic in the same transaction as the removal/deletion that caused it. |
| 2 | Last note removed from a class (0 left) | **Unreachable** if the invariant holds: a class can never persist at exactly 1 member, so the 1→0 transition never has anything to transition from. Worth testing as an explicit invariant, not just as isolated cases. |
| 3 | Drag cancelled (released off any target) | The `cancel` branch never calls a mutation function at all — there's nothing to roll back. |
| 4 | App backgrounded mid-drag | RNGH delivers a cancelled gesture state on touch interruption (including losing app focus); this must route through the same `cancel` path as an ordinary invalid drop — `drop` is only reachable from an explicit, completed gesture. |
| 5 | Drop target disappeared or changed mid-gesture (e.g. a collaborator's device deletes the note being hovered) | `dropTargetRegistry` unregisters a rect on its card's unmount, so a vanished target simply won't resolve in `hitTest` at release time. Additionally, `createClassFromNotes`/`addNoteToClass` re-validate their assumptions (target still `classId: null`, target class still exists) inside their own transaction rather than trusting state captured at hover time; a stale assumption makes the operation a silent no-op, not a crash or a corrupted class. |
| 6 | Note's content changed during the interaction | Already safe by construction — `updateNoteInTransaction` always reads the current row inside its transaction and patches only `classId`; it never writes back a client-cached copy of the whole note. |
| 7 | Drop a Class onto a Class | Unreachable — `ClassCard` is never a drag source (§6). |
| 8 | Create a nested Class | Unreachable for the same reason — no other class is ever on screen to drop onto from inside a class view. |
| 9 | Move a note directly from Class X to Class Y in one gesture | Unreachable by design — a class view shows only its own members plus the two temporary targets; moving between classes is necessarily two separate gestures (out via "All Notes", then in via a second drag from root). Noted as an intentional limitation, not a gap. |
| 10 | Rapid re-interaction with the same card right after a drop, before its async write/reload lands | Same `busy`-flag convention already used in `NoteEditor`/`ListEditor`: a card with an in-flight operation ignores a new long-press pickup on itself; other cards are unaffected since operations are independent per id. |
| 11 | Target's class membership changes between hover and release from an unrelated concurrent sync | Same re-validation as #5 — the commit function checks current state inside its transaction, not the state assumed at hover time. |
| 12 | Process killed mid-write | Already covered for free — every mutation here is already a single SQLite transaction via the existing `runLocalOperation` pattern; this feature adds no new atomicity requirement beyond what already exists. |

## 10. Testing strategy

Extends existing test files rather than introducing a parallel
structure (`test/data/classes.test.ts`, `test/state/classesStore.test.ts`,
`test/ui/notesFlow.test.tsx` already exist and already cover the
pre-existing pieces of this feature).

- **Data layer** — unit tests for `renameClass`, `createClassFromNotes`,
  `addNoteToClass`, `removeNoteFromClass`; a dedicated test asserting the
  ≥2-member invariant holds through both the remove-to-root path and the
  delete path; a test for the "assumption went stale mid-transaction"
  no-op behavior (§9 #5/#11).
- **Store layer** — `renameClass` action; a test confirming
  `createClassFromNotes`/`removeNoteFromClass` reload both `notesStore`
  and `classesStore`, not just one.
- **Interaction logic** — `dropTargetRegistry.hitTest` and the
  drop-target → mutation mapping (§6) are plain functions/reducers,
  fully unit-testable with no RN rendering involved.
- **Gesture wiring** — `react-native-gesture-handler` ships its own
  `jestSetup.js` for `setupFiles`; used to verify gesture callbacks are
  wired to the right store actions, not to simulate real touch timing
  (long-press duration, pan thresholds) or animation smoothness — those
  are validated manually on an Android device (Android-first per the
  project's engineering standard), which is also where a real
  responsiveness problem would surface and trigger reconsidering §3's
  Reanimated deferral.

## 11. Dependency and native setup changes

- `package.json`: add `"react-native-gesture-handler": "^3.3.0"` to
  `dependencies`. No Reanimated, no worklets, no separate haptics
  package.
- `index.js`: `import 'react-native-gesture-handler';` as the first
  line — RNGH's own documented requirement.
- `App.tsx`: wrap the existing root `<View style={styles.safeArea}>` in
  `<GestureHandlerRootView style={{flex: 1}}>`.
- No new Babel plugin (that's specific to Reanimated/worklets, not
  needed for RNGH alone).
- Android: expected to autolink through the existing
  Gradle/CMake path (`newArchEnabled=true`), but requires an actual
  native rebuild (`./gradlew`), not just a Metro JS reload — called out
  explicitly so it isn't mistaken for a plain `npm install`.

## 12. Implementation order

A rough shape for sanity-checking scope before `writing-plans` breaks it
into tasks properly:

1. Add the RNGH dependency + `index.js`/`GestureHandlerRootView` wiring
   + confirm the Android build still compiles and runs. Nothing else is
   testable until this works.
2. Data layer (§4) in full, with tests — independently testable with no
   UI involved.
3. Store layer (rename + cross-store reload coordination), with tests.
4. UI scaffolding: root/class navigation state, merged root feed
   selector, `ClassCard` — tap-only, no drag yet — with tests. Classes
   become visible and navigable before the highest-risk piece is added.
5. Gesture/animation layer (`dropTargetRegistry`, `useDraggable`,
   `useDragAnimation`, `useNoteDrag`) and its wiring into `NotesScreen`
   (pickup/drag/drop visuals, temporary targets).
6. Drag haptics.
7. Manual Android device verification — long-press-vs-scroll feel,
   animation smoothness, haptic timing; the decision point for whether
   to revisit §3.

## 13. What this spec does not settle

- **Localization.** Out of scope by design — see §1's forward reference.
  The next task handles it across the whole app, not just this feature.
- **Classes for Lists.** `lists.class_id` exists in the schema and is
  left unused by this feature, matching the original 2026-09-07 scoping
  and reaffirmed for this spec — a future decision if it's ever needed,
  not a data model change.
- **Explicit whole-class delete.** Not part of the product requirement;
  a class only ever disappears via the auto-dissolve invariant (§4),
  never via a direct "delete this class" action. If that's ever wanted,
  it's an additive UI affordance, not a data model change.

  **Addendum, confirmed 2026-09-17 while planning the sync-boundary-fix
  spec:** a class cannot be deleted while it still has member notes —
  the only way out of membership is the §4 dissolve invariant, which
  already guarantees a class never persists at 1 member. Consequently
  `deleteClassInTransaction`'s existing member-reflow loop (reassigning
  contained notes/lists to `classId: null` before deleting the row) is
  not a real state a correctly-used `deleteClass` should ever reach —
  it should instead reject deletion outright if any note/list still
  references the class, matching that a class can only legitimately be
  deleted once it's already empty. This is a required prerequisite for
  `2026-09-17-yunote-classes-sync-boundary-fix-design.md` §3.2, where it
  is what makes `deleteClass` unconditionally pure class-only (safe for
  `runLocalOnlyTransaction`) rather than conditionally mixed depending
  on whether the class happened to have members at call time.
- **Whether/when to adopt Reanimated.** Conditional on findings from the
  manual device-testing pass in §10/§12 step 7, not decided here.
- **Exact copy wording and pixel-level visual polish** beyond what §7
  specifies — consistent with how prior yuNote specs treat visual detail
  as an implementation-time concern, not a design-spec one.

## Self-Review Notes

- **Placeholder scan:** none — §13's items are explicit, reasoned
  deferrals, not unfilled gaps.
- **Internal consistency:** the ≥2-member invariant (§4) is referenced
  and reused consistently in §5 (why touching a class's `updated_at`
  matters for sort), §6 (why a class-view note-on-note drop is invalid
  rather than meaningful), and §9 (edge cases 1–2) rather than being
  redefined differently in each place. The "only `NoteCard` drags"
  decision (§6) is what resolves §9's edge cases 7–9, checked against
  each other while writing this rather than asserted independently.
- **Scope check:** focused on one feature (Classes interaction model for
  Notes). Localization and Lists-classification are explicitly named and
  deferred (§13) rather than silently expanded into.
- **Ambiguity check:** the two places most likely to be read two ways —
  "what does dropping a note on another note already in the same class
  do" (§6: invalid, cancels) and "what happens when a class would go to
  0 members" (§9 #2: unreachable given the invariant, not a separate
  code path) — are both made explicit rather than left implicit.
