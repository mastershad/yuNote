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
