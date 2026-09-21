# yuNote Local App — Design

## 1. Motivation

`yuNote` is a standalone, offline-first Notes/Lists app — the third of the
sequenced yuNote-ecosystem sub-projects (see
`mastershad/IoT-Key-Fob-Project`'s
`docs/superpowers/specs/2026-09-07-platform-account-layer-design.md` and
`docs/superpowers/specs/2026-09-07-yunote-cloud-layer-design.md` for the
first two, both already shipped/spec'd there). This spec designs the app
itself: its local data model, how the UI stays reactive to local changes,
and the touch-interaction architecture its product requirements call for.

Full product requirements (two-tab Notes/Lists UX, Classes as a purely
local organizational feature, gesture behavior, offline-first as the
non-negotiable core) were established earlier in the same discussion that
produced this spec and are treated here as settled — this document is
where they become a concrete local architecture, not where they're
re-derived.

**Core principle carried over from the Cloud Layer spec:** `yuNote` works
100% autonomously with zero setup. Everything in this document — the
local database, the UI, every gesture — must work with no account, no
pairing, no network. The sync/pairing layer this app can optionally
connect to (per the Cloud Layer spec) is consumed by this app, not
depended on by it.

## 2. Tech stack

- **React Native** (bare, no Expo) — matches
  `mastershad/IoT-Key-Fob-Project`'s `mobile-app/` stack for shared
  tooling/expertise: React Native 0.86, React 19, TypeScript 5.8.
- **`op-sqlite`** for local storage — a fast, JSI-based raw SQLite binding
  with no bundled ORM or sync framework. Chosen deliberately over
  WatermelonDB: this project consistently prefers writing its own thin,
  understood mechanisms over adopting a framework's built-in magic (the
  same reasoning that shaped the Cloud Layer spec's access-boundary
  design) — reactivity and sync are hand-rolled (§4, and the Cloud Layer
  spec respectively) rather than inherited from a library's opinions.
- **`react-native-gesture-handler` + `react-native-reanimated`** — the
  standard combination for the gesture work in §5; no other serious
  option exists in the current RN ecosystem for composed long-press/pan/
  swipe recognition.
- **Zustand** for UI state (§4) — lightweight, no boilerplate, matches the
  "no unnecessary abstraction" principle already applied throughout this
  project.

## 3. Local schema

```sql
CREATE TABLE classes (
  id TEXT PRIMARY KEY,          -- UUID, client-generated (offline-first --
                                 -- can never wait on a server for an id)
  name TEXT NOT NULL,
  created_at TEXT NOT NULL      -- ISO 8601, matching this ecosystem's
                                 -- existing convention (cloud-platform's
                                 -- schema.sql uses the same TEXT/ISO shape)
);
-- classes deliberately has no synced_at and is never touched by the sync
-- path in the Cloud Layer spec's client -- this is the schema-level
-- enforcement of "Classes are never transmitted to Key Fob/AI": the data
-- physically never enters the sync code path, rather than being filtered
-- out of it.

CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  class_id TEXT REFERENCES classes(id),   -- nullable: unclassified by default
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  synced_at TEXT                          -- NULL, or stale relative to
                                           -- updated_at, means "has local
                                           -- changes not yet pushed"
);

CREATE TABLE lists (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  synced_at TEXT
);

CREATE TABLE list_items (
  id TEXT PRIMARY KEY,
  list_id TEXT NOT NULL REFERENCES lists(id),
  text TEXT NOT NULL,
  checked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  synced_at TEXT
);
```

Notes:
- Lists have no `class_id` — the product requirements' Classes discussion
  (long-press → Move/Create Class, drag-to-create-class) is specified only
  for Notes; nothing calls for classifying Lists. If that's wrong, it's a
  one-column addition later, not a redesign.
- `synced_at` is the entire sync-tracking mechanism — no separate outbox
  table. A row is "dirty" when `synced_at IS NULL OR updated_at >
  synced_at`. The client-side half of the Cloud Layer spec's sync
  mechanism queries exactly that condition to know what to push, and sets
  `synced_at = now()` on successful push.

## 4. Reactivity

`op-sqlite` has no built-in reactive queries, so the UI does not read the
database directly. A thin repository layer is the only thing that touches
SQLite:

```ts
// One module per aggregate, e.g. src/data/notes.ts
createNote(input: { title: string; content: string; classId?: string }): Note
updateNote(id: string, patch: Partial<{ title: string; content: string; classId: string | null }>): Note
deleteNote(id: string): void
listNotes(options: { classId?: string | null; sort: 'date-desc' | 'date-asc' | 'title-asc' | 'title-desc' }): Note[]
```

Every repository function does two things in sequence: (1) write to
SQLite, (2) update a Zustand store holding the currently-displayed slice
of data. Screens subscribe to the Zustand store, never to SQLite directly.
This keeps the mental model simple — "write, then update what's on
screen" — without a query-observation framework to learn or debug.

## 5. Gesture architecture

Three product requirements need real interaction-design decisions:

**Long-press context menu that yields to scroll (§7 of the original
requirements).** Implemented as a `Gesture.LongPress()` composed with the
list's existing `Gesture.Pan()` via `Gesture.Race()`
(`react-native-gesture-handler`'s composed-gesture API): the long-press
gesture and the scroll/pan gesture are registered as racing against each
other on the same touch. If the touch's movement exceeds the pan
threshold before the long-press's duration threshold fires, the pan wins
and the touch continues as an ordinary scroll — the menu never appears in
that case, and there is no "tap outside to dismiss" step because the menu
was never a blocking modal to begin with, just an overlay racing against
motion.

**Drag-note-onto-note to create a class (§8).** A separate `Gesture.Pan()`
starting from an already-long-pressed note, tracked against the other
visible notes' measured layout rects (`onLayout` + a ref map) during the
drag; on release, if the drag position is over another note's rect, the
create-class flow (§8's cancel-safe naming step) fires. If cancelled
during naming, the two notes' `class_id` values are reverted and the
just-created `classes` row is deleted — no orphaned unnamed class survives
a cancel, per the explicit requirement.

**Swipe-right delete with undo (§11).** Superseded during implementation
(2026-09-21): the original reveal-a-delete-zone pattern below was judged
too heavy for individual list items once built (still considered right
for whole lists/cards, which use the separate drag-to-drop-zone gesture
in §5's note-drag design) and was replaced with a plain
`Gesture.Pan()`-driven threshold (`src/interaction/useSwipeToDelete.ts`):
crossing ~40% of the row's width on a rightward swipe animates the row
out and deletes it from SQLite immediately (still hard-deleted, not
soft-deleted — see §8 below for why), with no intermediate
reveal-the-zone step. An undo banner (`src/ui/usePendingItemUndo.ts`)
then shows for 4 seconds; tapping undo re-inserts the item via the same
`addItem` repository call used for a normal add. Accepted simplifications
from that reuse: the restored item gets a new id, is appended at the end
of the list (item order is `created_at ASC`), and loses its
checked/completion state. The undo banner is single-slot — swiping a
second item before the first one's window elapses silently replaces the
banner, and the first item's undo opportunity is gone. Both trade-offs
were confirmed with the product owner rather than assumed.

<details>
<summary>Original design (not implemented)</summary>

A `Swipeable`-style pan gesture on each list item reveals a delete-zone;
crossing a distance threshold on release deletes the row from SQLite
immediately (not soft-deleted — see §8 below for why) and shows an undo
toast holding the deleted row's full data in memory for a few seconds.
Tapping undo re-inserts it via the same `createListItem` repository
function used for a normal add — undo is not a special code path, it's a
normal create using remembered data.

</details>

## 6. Schema migrations

SQLite's own `PRAGMA user_version` (an integer stored in the database file
itself) tracks the schema version — no separate migrations table. At app
startup: read `PRAGMA user_version`, run each not-yet-applied migration in
an ordered array (`[{ version: 1, up: (db) => {...} }, ...]`), bump
`user_version` after each. This mirrors the spirit of
`cloud-platform/src/db/db.ts`'s own idempotent-migration approach on the
server side, adapted to a client with no separate "fresh vs. existing
database" distinction to worry about (every device's SQLite file starts
at `user_version = 0` and migrates forward from there, including a
brand-new install — there's no equivalent of the server's `CREATE TABLE IF
NOT EXISTS`-for-fresh-installs shortcut, every device runs every
migration once).

## 7. Relationship to sync (forward reference, not designed here)

This app's only sync-relevant surface is `synced_at` (§3) and the
repository layer's ability to answer "what's dirty" (§4). The actual push
mechanism, auth/pairing trigger, and cloud-side schema are the Cloud Layer
spec's responsibility (`docs/superpowers/specs/2026-09-07-yunote-cloud-layer-design.md`
in `IoT-Key-Fob-Project`) and are not re-designed here. This app must be
fully buildable and testable with that piece entirely absent.

## 8. What this spec does not settle

- **Soft-delete / tombstones for sync.** §5's list-item delete is a hard
  delete from local SQLite. Once sync exists, a hard-deleted row can't be
  told apart from "never existed" when reconciling against the cloud
  replica. Whether that needs a tombstone mechanism is the sync
  implementation's question, not this app's — noting it here so it isn't
  lost.
- **Note/List search.** Not in the original product requirements; not
  designed here.
- **Exact visual design** (colors, spacing, animation curves) — this spec
  covers data and interaction architecture, not visual design.

## Self-Review Notes

- Placeholder scan: none — §7 and §8's forward references are explicit
  deferrals with stated reasons, not unfilled gaps.
- Internal consistency: §3's "classes never enters the sync path"
  statement is the same invariant the Cloud Layer spec's §5 independently
  arrives at from the server side (AI-facing reads structurally exclude
  `class_id`) — both specs enforce the same requirement from their own
  side of the boundary, checked against each other while writing this.
- Scope check: local app only. No Key Fob integration code, no cloud
  schema — both stay in their own already-written spec.
- Ambiguity check: whether Lists get Classes was ambiguous in the original
  requirements (only ever discussed for Notes); resolved explicitly in §3
  as "no, one-column addition later if wrong" rather than left silent.
