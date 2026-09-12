# yuNote Working Local UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a standalone Android yuNote application that can create, edit, persist, and delete local notes and checklists without Metro, an account, or a network connection.

**Architecture:** A root React Native component opens the migrated SQLite database once and constructs the existing Zustand stores. Two top-level screens and modal editors consume narrow store interfaces, keeping UI tests independent from native SQLite while production uses the real repositories.

**Tech Stack:** React Native 0.86, React 19.2, TypeScript 5.8, Zustand 5, op-sqlite, Jest, react-test-renderer, Android/Kotlin.

**Spec:** `docs/superpowers/specs/2026-09-12-yunote-working-local-ui-design.md`

## Global Constraints

- Local notes and lists must work with no account, Key Fob connection, Metro server, or network.
- Persist all mutations through the existing Zustand/SQLite stores.
- Use no new runtime dependency for navigation or icons.
- Support device-selected light and dark themes with Russian user-facing copy.
- Lock Android to portrait, keep the status bar visible, and hide the navigation bar with transient edge-swipe reveal.
- Existing data, journal, relay, migration, and security tests remain green.

---

### Task 1: Testable application bootstrap and visual foundation

**Files:**
- Create: `index.js`
- Create: `App.tsx`
- Create: `src/app/stores.ts`
- Create: `src/ui/theme.ts`
- Create: `test/ui/theme.test.ts`
- Create: `test/ui/appShell.test.tsx`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `tsconfig.json`

**Interfaces:**
- Produces: `AppStores`, `createAppStores(db): AppStores`, `ThemePalette`, `getThemePalette('light' | 'dark')`.
- `App` accepts optional `bootstrap?: () => Promise<AppStores>` for deterministic tests.

- [ ] Write tests asserting distinct accessible theme palettes, startup loading/error/retry states, and Notes/Lists tab switching.
- [ ] Run `npm test -- --runInBand test/ui/theme.test.ts test/ui/appShell.test.tsx` and confirm failure because the UI modules do not exist.
- [ ] Add matching `react-test-renderer` and its types as development dependencies.
- [ ] Implement store construction, app registration, semantic theme tokens, boot state, and two-tab shell.
- [ ] Run the focused tests and `npm run typecheck`.
- [ ] Commit with `feat: bootstrap yuNote local interface`.

### Task 2: Working Notes screen and editor

**Files:**
- Create: `src/ui/components.tsx`
- Create: `src/ui/NotesScreen.tsx`
- Create: `src/ui/NoteEditor.tsx`
- Create: `test/ui/notesFlow.test.tsx`
- Modify: `App.tsx`

**Interfaces:**
- Consumes: `AppStores.notes`, whose state exposes `notes`, `loadNotes`, `createNote`, `updateNote`, and `deleteNote`.
- Produces: `NotesScreen({ store, palette }): ReactElement` and editor callbacks using repository-backed store actions.

- [ ] Write tests that load the note collection, open create, validate/save a note, open/edit an existing note, and confirm deletion.
- [ ] Run the focused test and confirm failure because the screen does not exist.
- [ ] Implement reusable header, empty state, card, modal sheet, text fields, actions, busy state, and retained error feedback.
- [ ] Wire Notes into the application shell and keep draft content when a mutation throws.
- [ ] Run focused tests and typecheck.
- [ ] Commit with `feat: add local notes interface`.

### Task 3: Working Lists screen and checklist editor

**Files:**
- Create: `src/ui/ListsScreen.tsx`
- Create: `src/ui/ListEditor.tsx`
- Create: `test/ui/listsFlow.test.tsx`
- Modify: `App.tsx`
- Modify: `src/ui/components.tsx`

**Interfaces:**
- Consumes: `AppStores.lists`, whose state exposes `lists`, `itemsByListId`, `loadLists`, `createList`, `deleteList`, `loadItems`, `addItem`, `toggleItem`, and `removeItem`.
- Produces: list cards with completion summaries and a checklist editor.

- [ ] Write tests for list creation validation, opening a list, adding/toggling/removing items, and confirmed list deletion.
- [ ] Run the focused test and confirm failure.
- [ ] Implement the collection and checklist editor with non-empty validation, checkbox controls, completion counts, and mutation error retention.
- [ ] Wire Lists into the application shell.
- [ ] Run focused tests and typecheck.
- [ ] Commit with `feat: add local checklist interface`.

### Task 4: Android display and release contracts

**Files:**
- Create: `android/app/src/main/java/com/com.yunote.app/SystemBarsModule.kt`
- Create: `android/app/src/main/java/com/com.yunote.app/SystemBarsPackage.kt`
- Create: `test/ui/androidContract.test.ts`
- Modify: `android/app/src/main/java/com/com.yunote.app/MainApplication.kt`
- Modify: `android/app/src/main/AndroidManifest.xml`
- Modify: `App.tsx`

**Interfaces:**
- Produces native module `SystemBars.setNavigationBarStyle(backgroundColor, darkIcons)`.
- Activity requests `android:screenOrientation="portrait"`.

- [ ] Write a source-contract test for portrait lock, package registration, navigation-bar hiding, and transient swipe behavior.
- [ ] Run the focused test and confirm failure.
- [ ] Implement the Android module using `WindowInsetsController` on API 30+ and immersive flags on older Android.
- [ ] Register the package and invoke it whenever the theme changes.
- [ ] Run focused tests, typecheck, and `android\gradlew.bat app:assembleRelease`.
- [ ] Commit with `feat: configure yuNote immersive portrait display`.

### Task 5: Full regression and real-device acceptance

**Files:**
- Modify only files required by defects found during acceptance.
- Create screenshots outside the repository.

- [ ] Run `npm test -- --runInBand`, expecting all suites to pass.
- [ ] Run `npm run typecheck`, expecting zero errors.
- [ ] Run `git diff --check`.
- [ ] Build `android\app\build\outputs\apk\release\app-release.apk`.
- [ ] Install with `adb install -r`, stop Metro, launch yuNote, create a note and checklist, force-stop/relaunch, and verify both persist.
- [ ] Capture Notes and Lists screenshots and inspect portrait layout, both theme surfaces where practical, tab labels, status bar, and hidden navigation bar.
- [ ] Commit any acceptance fixes with a focused message and rerun affected checks.

