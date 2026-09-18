import { useRef } from 'react';
import { Animated } from 'react-native';

export function useDragAnimation() {
  const position = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;
  const scale = useRef(new Animated.Value(1)).current;
  const opacity = useRef(new Animated.Value(1)).current;

  // useNativeDriver is deliberately OFF on every animation here (not the
  // library's usual default) -- with it on, a native-driven Animated.timing
  // updating props on a View that GestureDetector also wraps hits a Fabric
  // assertion failure (SurfaceMountingManager.overridePropsReadableMap)
  // under the New Architecture, crashing the app on every pickup. Confirmed
  // via on-device reproduction: a plain long-press-hold with zero movement
  // reproduces it, isolating the cause to playPickUp's native-driven
  // animation, not gesture recognition or movement. All animations here
  // (including position, since it shares the same style.transform array
  // with scale -- mixing native- and JS-driven values across one transform
  // triggers its own separate RN warning/crash) run on the JS thread
  // instead.
  const playPickUp = () => {
    Animated.timing(scale, { toValue: 0.94, duration: 150, useNativeDriver: false }).start();
    Animated.timing(opacity, { toValue: 0.95, duration: 150, useNativeDriver: false }).start();
  };

  const playMove = (point: { x: number; y: number }) => {
    position.setValue(point);
  };

  const playDropSuccess = (target: { x: number; y: number }): Promise<void> =>
    new Promise((resolve) => {
      Animated.parallel([
        Animated.spring(position, { toValue: target, useNativeDriver: false }),
        Animated.timing(scale, { toValue: 0, duration: 220, useNativeDriver: false }),
        Animated.timing(opacity, { toValue: 0, duration: 220, useNativeDriver: false }),
      ]).start(() => resolve());
    });

  const playCancel = (): Promise<void> =>
    new Promise((resolve) => {
      Animated.parallel([
        Animated.spring(position, { toValue: { x: 0, y: 0 }, useNativeDriver: false }),
        Animated.spring(scale, { toValue: 1, useNativeDriver: false }),
        Animated.timing(opacity, { toValue: 1, duration: 150, useNativeDriver: false }),
      ]).start(() => resolve());
    });

  const reset = () => {
    position.setValue({ x: 0, y: 0 });
    scale.setValue(1);
    opacity.setValue(1);
  };

  return {
    style: {
      transform: [{ translateX: position.x }, { translateY: position.y }, { scale }],
      opacity,
    },
    playPickUp,
    playMove,
    playDropSuccess,
    playCancel,
    reset,
  };
}
