import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { useDraggable } from '../../src/interaction/useDraggable';
import type { DraggableCallbacks } from '../../src/interaction/useDraggable';
import type { Rect } from '../../src/interaction/dropTargetRegistry';

// react-test-renderer (already used throughout this repo's UI tests, see
// test/ui/*.test.tsx) is used here instead of adding
// @testing-library/react-hooks as a new devDependency: a tiny host
// component that calls the hook and hands its result back out is enough
// to express this smoke test honestly, and it keeps the same
// render/act pattern the rest of the suite already relies on.
function HookHost(props: { id: string; measureOrigin: () => Rect; callbacks: DraggableCallbacks; onResult: (result: unknown) => void }) {
  const gesture = useDraggable(props.id, props.measureOrigin, props.callbacks);
  props.onResult(gesture);
  return null;
}

describe('useDraggable', () => {
  it('returns a composed Gesture object (smoke test -- real recognition is validated manually on-device)', () => {
    const callbacks: DraggableCallbacks = {
      onPickUp: jest.fn(),
      onMove: jest.fn(),
      onDrop: jest.fn(),
      onCancel: jest.fn(),
    };
    const origin = jest.fn(() => ({ x: 0, y: 0, width: 100, height: 100 }));

    let result: unknown;
    act(() => {
      TestRenderer.create(
        React.createElement(HookHost, {
          id: 'note-1',
          measureOrigin: origin,
          callbacks,
          onResult: (r) => {
            result = r;
          },
        }),
      );
    });

    expect(result).toBeDefined();
    // RNGH's composed gesture objects don't expose a simple "call onStart"
    // API outside its own native test harness -- verifying the callbacks
    // actually fire on a real long-press+pan is a manual, on-device check
    // (Task 12), not something this hook-level test can simulate honestly.
  });
});
