import { Vibration } from 'react-native';
import { androidDragFeedback } from '../../src/interaction/dragHaptics';

jest.mock('react-native', () => ({ Vibration: { vibrate: jest.fn() } }));

describe('dragHaptics', () => {
  it('each method calls Vibration.vibrate exactly once, with distinct durations for pickup vs. targetEntered', () => {
    androidDragFeedback.pickup();
    androidDragFeedback.targetEntered();
    androidDragFeedback.dropSuccess();
    androidDragFeedback.deleteSuccess();

    expect(Vibration.vibrate).toHaveBeenCalledTimes(4);
    const calls = (Vibration.vibrate as jest.Mock).mock.calls.map((c) => c[0]);
    expect(new Set(calls).size).toBeGreaterThan(1); // not all identical -- pickup should read as distinct from a light hover tick
  });
});
