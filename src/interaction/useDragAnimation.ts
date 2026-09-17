import { useRef } from 'react';
import { Animated } from 'react-native';

export function useDragAnimation() {
  const position = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;
  const scale = useRef(new Animated.Value(1)).current;
  const opacity = useRef(new Animated.Value(1)).current;

  const playPickUp = () => {
    Animated.timing(scale, { toValue: 0.94, duration: 150, useNativeDriver: true }).start();
    Animated.timing(opacity, { toValue: 0.95, duration: 150, useNativeDriver: true }).start();
  };

  const playMove = (point: { x: number; y: number }) => {
    position.setValue(point);
  };

  const playDropSuccess = (target: { x: number; y: number }): Promise<void> =>
    new Promise((resolve) => {
      Animated.parallel([
        Animated.spring(position, { toValue: target, useNativeDriver: true }),
        Animated.timing(scale, { toValue: 0, duration: 220, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0, duration: 220, useNativeDriver: true }),
      ]).start(() => resolve());
    });

  const playCancel = (): Promise<void> =>
    new Promise((resolve) => {
      Animated.parallel([
        Animated.spring(position, { toValue: { x: 0, y: 0 }, useNativeDriver: true }),
        Animated.spring(scale, { toValue: 1, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 150, useNativeDriver: true }),
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
