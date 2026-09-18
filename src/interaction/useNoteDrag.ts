import { useCallback, useRef, useState } from 'react';
import type { OpSqliteDb } from '../db/connection';
import { createDropTargetRegistry, type Rect } from './dropTargetRegistry';
import { useDraggable } from './useDraggable';
import { useDragAnimation } from './useDragAnimation';
import { createClassFromNotesAndReload, addNoteToClassAndReload, removeNoteFromClassAndReload } from '../state/classInteractions';
import type { createNotesStore } from '../state/notesStore';
import type { createClassesStore } from '../state/classesStore';
import { androidDragFeedback, type DragFeedback } from './dragHaptics';

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
  feedback?: DragFeedback;
}) {
  const feedback = context.feedback ?? androidDragFeedback;
  const registry = useRef(createDropTargetRegistry()).current;
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [hoveredTargetId, setHoveredTargetId] = useState<string | null>(null);
  const lastHoveredRef = useRef<string | null>(null);
  const animation = useDragAnimation();

  const fns: DropResolutionFns = {
    createClassFromNotes: (input) => createClassFromNotesAndReload(context.db, context.notesStore, context.classesStore, input),
    addNoteToClass: (input) => addNoteToClassAndReload(context.db, context.notesStore, context.classesStore, input),
    removeNoteFromClass: (noteId) => removeNoteFromClassAndReload(context.db, context.notesStore, context.classesStore, noteId),
    deleteNote: (noteId) => context.notesStore.getState().deleteNote(noteId),
  };

  // Stable identity across renders matters here, not just as a
  // micro-optimization: useNoteDrag returns a fresh object every render
  // (it has no reason not to -- draggingId/hoveredTargetId are real state),
  // so a caller's cleanup effect that depends on the WHOLE returned object
  // (or on a fresh-every-render function pulled off it) re-fires its
  // cleanup on every unrelated re-render, not just on real unmount/id
  // changes. That silently unregistered every drop target the moment any
  // drag-related state changed (e.g. onPickUp's setDraggingId), and
  // registerTarget never re-ran to fix it (onLayout only fires on a real
  // layout change) -- found via on-device testing: hitTest kept returning
  // null for a point that was mathematically inside a target's rect logged
  // moments earlier. registry itself never changes (useRef), so these have
  // no real dependencies -- useCallback(_, []) gives them permanent
  // identity, which is what callers must depend on instead of the whole
  // hook return value.
  const registerTarget = useCallback((id: string, rect: Rect) => { registry.register(id, rect); }, [registry]);
  const unregisterTarget = useCallback((id: string) => { registry.unregister(id); }, [registry]);

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
      onPickUp: () => { setDraggingId(noteId); feedback.pickup(); animation.playPickUp(); },
      onMove: (_id, point, translation) => {
        // point (window-absolute) drives hit-testing against
        // dropTargetRegistry's window-absolute rects; translation (RNGH's
        // own gesture-start-relative delta) drives the card's own
        // transform -- translateX/Y offsets a view from ITS layout
        // position, not from the window origin, so feeding it the
        // absolute point made the card jump away from the finger.
        animation.playMove(translation);
        const hit = registry.hitTest(point);
        if (hit !== null && hit !== lastHoveredRef.current) feedback.targetEntered();
        lastHoveredRef.current = hit;
        setHoveredTargetId(hit);
      },
      onDrop: async (_id, point, translation) => {
        const targetId = registry.hitTest(point);
        const targetType = targetId ? (idToType(targetId) ?? targetTypeFor(targetId)) : null;
        if (targetId && targetType) {
          if (targetType === 'delete') feedback.deleteSuccess(); else feedback.dropSuccess();
          await animation.playDropSuccess(translation);
          await resolveDrop({ screen: context.screen, draggedId: noteId, targetId, targetType }, fns);
        } else {
          await animation.playCancel();
        }
        animation.reset();
        setDraggingId(null);
        setHoveredTargetId(null);
        lastHoveredRef.current = null;
      },
      onCancel: async () => {
        await animation.playCancel();
        animation.reset();
        setDraggingId(null);
        setHoveredTargetId(null);
        lastHoveredRef.current = null;
      },
    });
  }

  return { draggingId, hoveredTargetId, animation, registerTarget, unregisterTarget, useDragForNote };
}
