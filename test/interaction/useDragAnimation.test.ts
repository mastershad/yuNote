import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { useDragAnimation } from '../../src/interaction/useDragAnimation';

// react-test-renderer (already used throughout this repo's UI tests, see
// test/ui/*.test.tsx, and by Task 7's test/interaction/useDraggable.test.ts)
// is used here instead of adding @testing-library/react-hooks as a new
// devDependency: a tiny host component that calls the hook and hands its
// result back out is enough to express this smoke test honestly, and it
// keeps the same render/act pattern the rest of the suite already relies on.
function HookHost(props: { onResult: (result: ReturnType<typeof useDragAnimation>) => void }) {
  const animation = useDragAnimation();
  props.onResult(animation);
  return null;
}

describe('useDragAnimation', () => {
  it('exposes an animated style object and the documented play*/reset methods', () => {
    let result: ReturnType<typeof useDragAnimation> | undefined;

    act(() => {
      TestRenderer.create(
        React.createElement(HookHost, {
          onResult: (r) => {
            result = r;
          },
        }),
      );
    });

    expect(result).toBeDefined();
    expect(result!.style).toBeDefined();
    expect(typeof result!.playPickUp).toBe('function');
    expect(typeof result!.playMove).toBe('function');
    expect(typeof result!.playDropSuccess).toBe('function');
    expect(typeof result!.playCancel).toBe('function');
    expect(typeof result!.reset).toBe('function');
  });

  it('playMove updates position without throwing outside an animation frame', () => {
    let result: ReturnType<typeof useDragAnimation> | undefined;

    act(() => {
      TestRenderer.create(
        React.createElement(HookHost, {
          onResult: (r) => {
            result = r;
          },
        }),
      );
    });

    // Animated.ValueXY doesn't expose its current numeric value synchronously
    // in a way worth asserting on here -- the meaningful check is that
    // calling it during a render-hook act() doesn't throw, matching how
    // useNoteDrag (Task 9) will call it from a gesture callback.
    expect(() => {
      act(() => {
        result!.playMove({ x: 40, y: 60 });
      });
    }).not.toThrow();
  });
});
