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
