import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { shouldCommitSwipe, useSwipeToDelete } from '../../src/interaction/useSwipeToDelete';

describe('shouldCommitSwipe (rightward swipe-to-delete threshold)', () => {
  it('does not commit with no movement', () => {
    expect(shouldCommitSwipe(0, 100)).toBe(false);
  });

  it('does not commit below the threshold', () => {
    expect(shouldCommitSwipe(39, 100)).toBe(false);
  });

  it('commits at the threshold', () => {
    expect(shouldCommitSwipe(40, 100)).toBe(true);
  });

  it('commits past the threshold', () => {
    expect(shouldCommitSwipe(80, 100)).toBe(true);
  });

  it('never commits on a leftward swipe, regardless of distance', () => {
    expect(shouldCommitSwipe(-80, 100)).toBe(false);
  });

  it('never commits when the row has not been measured yet (zero width)', () => {
    expect(shouldCommitSwipe(50, 0)).toBe(false);
  });
});

// react-test-renderer (already used throughout this repo, see
// test/interaction/useDraggable.test.ts) instead of adding
// @testing-library/react-hooks: a tiny host component calls the hook and
// hands its result back out.
function HookHost(props: { rowWidth: number; enabled: boolean; onCommit: () => void; onResult: (result: ReturnType<typeof useSwipeToDelete>) => void }) {
  const result = useSwipeToDelete(props.rowWidth, { enabled: props.enabled, onCommit: props.onCommit });
  props.onResult(result);
  return null;
}

describe('useSwipeToDelete', () => {
  it('exposes a Gesture and an animated style (smoke test -- real recognition is validated manually on-device, same as useDraggable)', () => {
    let result: ReturnType<typeof useSwipeToDelete> | undefined;

    act(() => {
      TestRenderer.create(
        React.createElement(HookHost, {
          rowWidth: 200,
          enabled: true,
          onCommit: jest.fn(),
          onResult: (r) => {
            result = r;
          },
        }),
      );
    });

    expect(result).toBeDefined();
    expect(result!.gesture).toBeDefined();
    expect(result!.style).toBeDefined();
  });
});
