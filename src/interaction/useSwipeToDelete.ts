import { useRef } from 'react';
import { Animated } from 'react-native';
import { Gesture } from 'react-native-gesture-handler';

const COMMIT_THRESHOLD_RATIO = 0.4;

// The decision logic, as a pure function -- exported separately from the
// hook so it's testable without React or a gesture library, same reasoning
// as useNoteDrag's resolveDrop.
export function shouldCommitSwipe(translationX: number, rowWidth: number, thresholdRatio = COMMIT_THRESHOLD_RATIO): boolean {
  if (rowWidth <= 0) return false; // row not measured yet -- never commit
  if (translationX <= 0) return false; // leftward swipe never deletes
  return translationX / rowWidth >= thresholdRatio;
}

export function useSwipeToDelete(rowWidth: number, options: { enabled: boolean; onCommit: () => void }) {
  const translateX = useRef(new Animated.Value(0)).current;
  const opacity = useRef(new Animated.Value(1)).current;

  const springBack = () => {
    Animated.spring(translateX, { toValue: 0, useNativeDriver: false }).start();
  };

  const gesture = Gesture.Pan()
    .enabled(options.enabled)
    .activeOffsetX(10)
    .onUpdate((event) => {
      translateX.setValue(Math.max(0, event.translationX));
    })
    .onEnd((event, success) => {
      if (!success) return; // onFinalize handles the spring-back
      if (shouldCommitSwipe(event.translationX, rowWidth)) {
        Animated.parallel([
          Animated.timing(translateX, { toValue: rowWidth + 40, duration: 200, useNativeDriver: false }),
          Animated.timing(opacity, { toValue: 0, duration: 200, useNativeDriver: false }),
        ]).start(() => options.onCommit());
      } else {
        springBack();
      }
    })
    .onFinalize((_event, success) => {
      if (!success) springBack();
    });

  return {
    gesture,
    style: {
      transform: [{ translateX }],
      opacity,
    },
  };
}
