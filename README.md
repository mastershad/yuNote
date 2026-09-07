# yuNote

Standalone, offline-first Notes/Lists mobile app — works with zero account,
zero network, and zero Key Fob dependency until explicitly linked. Native
ecosystem product for [Key Fob](https://github.com/mastershad/IoT-Key-Fob-Project);
see that repo for the platform/account layer and cloud-sync design.

## Status (2026-09-07)

**Local data layer — shipped, on `main`.** React Native + `@op-engineering/op-sqlite`.
SQLite schema (`notes`/`lists`/`list_items`/`classes` — `classes` is a purely
local organizational feature, structurally excluded from ever syncing
anywhere), atomic `PRAGMA user_version` migrations, repository functions,
Zustand stores. 41 tests passing, `tsc --noEmit` clean. Design:
`docs/superpowers/specs/2026-09-07-yunote-local-app-design.md`.

**Not started yet:**
- **Screens/gestures** (Notes/Lists tabs, long-press menu, drag-to-create-class,
  swipe-to-delete) — deliberately deferred, waiting on a visual design pass.
  No native `android/`/`ios/` project scaffolding exists yet either.
- **Cloud sync** — the design is settled
  (`IoT-Key-Fob-Project`'s `docs/superpowers/specs/2026-09-07-yunote-cloud-layer-design.md`)
  and an implementation plan is written
  (`IoT-Key-Fob-Project`'s `docs/superpowers/plans/2026-09-07-yunote-cloud-layer-implementation.md`),
  but that plan lives entirely in `cloud-platform` (the other repo) and
  hasn't been executed yet. This repo's own client-side push code (calling
  the new `/yunote/sync/*` endpoints once they exist) is not yet written
  either — it depends on that plan landing first.

## Repo layout

- `src/db/` — SQLite connection + migrations
- `src/data/` — repository functions (classes/notes/lists)
- `src/state/` — Zustand stores
- `docs/superpowers/specs/` and `docs/superpowers/plans/` — design/implementation records (this project's convention, shared with `IoT-Key-Fob-Project`)

## Development

```bash
npm install
npm test        # jest, 41 tests
npm run typecheck
```
