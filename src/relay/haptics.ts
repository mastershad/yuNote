import { Vibration } from 'react-native';

/**
 * A short, distinct pulse for content that arrived from elsewhere -- a Key
 * Fob voice capture (same-phone relay) or a collaborator's change (cross-
 * device collaboration inbox) -- never for an edit made directly in this
 * app's own UI, which the person doing it can already see happen.
 */
export interface HapticFeedback {
  arrivalPulse(): void;
}

export const androidVibrationFeedback: HapticFeedback = {
  arrivalPulse() {
    Vibration.vibrate(60);
  },
};
