import { useRef, useState } from 'react';

export interface PendingUndo {
  itemId: string;
  text: string;
}

export function usePendingItemUndo(restore: (text: string) => Promise<unknown>, undoWindowMs = 4000) {
  const [pending, setPending] = useState<PendingUndo | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const show = (next: PendingUndo) => {
    clearTimer();
    setPending(next);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setPending(null);
    }, undoWindowMs);
  };

  const confirmUndo = () => {
    if (pending === null) return;
    clearTimer();
    const restored = pending;
    setPending(null);
    void restore(restored.text);
  };

  // For when the pending item's context goes away without the user acting
  // on it (e.g. the list it belonged to was navigated away from) -- clears
  // the banner without restoring, unlike confirmUndo.
  const dismiss = () => {
    clearTimer();
    setPending(null);
  };

  return { pending, show, confirmUndo, dismiss };
}
