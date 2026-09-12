# yuNote Working Local UI — Design

## Goal

Turn the existing Android shell and local data layer into a usable offline-first notes application. A user must be able to launch yuNote without Metro or a network connection, create and edit notes and lists, close the application, reopen it, and find the same data in local SQLite.

This first UI release does not depend on Key Fob, an account, cloud sync, or the relay being available. Those systems may update the same repositories later, but the local user flow remains autonomous.

## Chosen approach

Use React Native primitives and the dependencies already present in the repository. The app owns a small two-tab navigation state rather than adding a navigation framework before the screen hierarchy needs one.

Alternatives considered:

1. Add React Navigation and gesture libraries immediately. This prepares deeper navigation and advanced gestures, but adds packages and native integration before the basic product is usable.
2. Build the first complete local UI with React Native primitives. This is the selected approach: fewer failure modes, smaller APK changes, and direct integration with the existing Zustand/SQLite layer.
3. Build the interface natively in Kotlin. This would duplicate the TypeScript state layer and split the product architecture, so it is rejected.

## Application structure

`index.js` registers the `yuNote` component. `App.tsx` owns startup, theme selection, and the active top-level tab.

At startup the app opens and migrates `yunote.sqlite`, creates the Notes and Lists stores once, loads their initial slices, and renders a recoverable error screen if initialization fails. The database handle remains open for the app lifetime.

The main interface has two persistent destinations:

- Notes: a card list ordered by most recently updated.
- Lists: a collection of named checklists.

Editors are modal workspaces layered over the selected destination. This keeps the first hierarchy shallow and makes Android back handling predictable.

## Notes flow

The Notes screen shows title, content preview, and update time. An empty state explains the first action. The primary add control opens a note editor.

The editor supports creating and updating title and body. A blank title is stored as “Untitled” while preserving the body. Saving writes through `createNotesStore` or `updateNote`; the visible collection updates from the store. Deletion requires an explicit destructive confirmation and is available only for an existing note.

Classes remain in the database architecture but are deferred from this first UI because the intended long-press and drag interaction needs its own focused implementation. Existing notes with a class remain readable.

## Lists flow

The Lists screen shows named list cards with completed and total item counts. Creating a list requires a non-empty title.

Opening a list shows its items. The user can add a non-empty item, toggle completion, and remove an item. Deleting the entire list requires an explicit confirmation. Every mutation goes through `createListsStore`, so SQLite and the rendered state change together.

## Visual system

The interface follows the installed raccoon icon:

- electric blue to violet accents;
- soft rounded surfaces inspired by the note card in the mascot’s paws;
- graphite text and controls from the raccoon markings;
- friendly, high-contrast typography and generous touch targets.

Light and dark themes follow the device color scheme in this release. Both themes use the same semantic tokens and preserve contrast. The Android activity is portrait-only. The bottom system navigation bar hides while the app is active and can return transiently with an edge swipe; the status bar remains visible.

All user-facing copy is Russian for the installed prototype.

## Error handling

Initialization failure renders a clear local-database error with a Retry action. Mutation failures keep the editor open and show a concise message; entered text is not discarded. Empty input is validated before calling repositories.

No network error can block local editing because the first UI performs no network request.

## Testing and verification

Tests cover:

- application registration and startup states;
- switching between Notes and Lists;
- note create/update/delete behavior through injected stores;
- list creation, item addition, toggling, item removal, and list deletion;
- empty-input validation;
- light and dark theme token contrast contract;
- Android portrait and bundled-release contract.

Existing data, relay, journal, migration, and security tests must remain green. Final verification includes TypeScript, the full Jest suite, a release Gradle build, installation on the connected phone, relaunch without Metro, a persistence check, and screenshots of both primary screens.

