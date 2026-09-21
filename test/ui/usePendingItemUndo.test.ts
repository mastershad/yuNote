import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { usePendingItemUndo } from '../../src/ui/usePendingItemUndo';

// react-test-renderer host, same pattern as
// test/interaction/useDragAnimation.test.ts.
function HookHost(props: { restore: (text: string) => Promise<unknown>; onResult: (result: ReturnType<typeof usePendingItemUndo>) => void }) {
  const result = usePendingItemUndo(props.restore);
  props.onResult(result);
  return null;
}

function renderHook(restore: (text: string) => Promise<unknown>) {
  let result!: ReturnType<typeof usePendingItemUndo>;
  const setResult = (r: ReturnType<typeof usePendingItemUndo>) => {
    result = r;
  };
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(React.createElement(HookHost, { restore, onResult: setResult }));
  });
  return {
    get current() {
      return result;
    },
    rerender: () => act(() => tree.update(React.createElement(HookHost, { restore, onResult: setResult }))),
  };
}

describe('usePendingItemUndo', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('starts with nothing pending', () => {
    const hook = renderHook(jest.fn());
    expect(hook.current.pending).toBeNull();
  });

  it('show() makes the item pending', () => {
    const hook = renderHook(jest.fn());
    act(() => hook.current.show({ itemId: 'i1', text: 'Молоко' }));
    hook.rerender();
    expect(hook.current.pending).toEqual({ itemId: 'i1', text: 'Молоко' });
  });

  it('auto-clears after the undo window without restoring', () => {
    const restore = jest.fn();
    const hook = renderHook(restore);
    act(() => hook.current.show({ itemId: 'i1', text: 'Молоко' }));
    act(() => jest.advanceTimersByTime(4000));
    hook.rerender();
    expect(hook.current.pending).toBeNull();
    expect(restore).not.toHaveBeenCalled();
  });

  it('confirmUndo() restores the item and clears pending immediately', () => {
    const restore = jest.fn(async () => undefined);
    const hook = renderHook(restore);
    act(() => hook.current.show({ itemId: 'i1', text: 'Молоко' }));
    hook.rerender();
    act(() => hook.current.confirmUndo());
    expect(restore).toHaveBeenCalledWith('Молоко');
    hook.rerender();
    expect(hook.current.pending).toBeNull();
  });

  it('confirmUndo() after the window already auto-cleared is a no-op', () => {
    const restore = jest.fn();
    const hook = renderHook(restore);
    act(() => hook.current.show({ itemId: 'i1', text: 'Молоко' }));
    act(() => jest.advanceTimersByTime(4000));
    hook.rerender();
    act(() => hook.current.confirmUndo());
    expect(restore).not.toHaveBeenCalled();
  });

  it('a second show() before the first window elapses replaces pending and does not let the old timer clear the new item early', () => {
    const restore = jest.fn();
    const hook = renderHook(restore);
    act(() => hook.current.show({ itemId: 'i1', text: 'Молоко' }));
    act(() => jest.advanceTimersByTime(3000));
    act(() => hook.current.show({ itemId: 'i2', text: 'Хлеб' }));
    hook.rerender();
    // Old timer's original deadline (1000ms from here) must not fire early.
    act(() => jest.advanceTimersByTime(1000));
    hook.rerender();
    expect(hook.current.pending).toEqual({ itemId: 'i2', text: 'Хлеб' });
    // New timer's own full window still clears it.
    act(() => jest.advanceTimersByTime(3000));
    hook.rerender();
    expect(hook.current.pending).toBeNull();
  });

  it('dismiss() clears pending without restoring (e.g. the list was switched away from)', () => {
    const restore = jest.fn();
    const hook = renderHook(restore);
    act(() => hook.current.show({ itemId: 'i1', text: 'Молоко' }));
    hook.rerender();
    act(() => hook.current.dismiss());
    expect(restore).not.toHaveBeenCalled();
    hook.rerender();
    expect(hook.current.pending).toBeNull();
    // The old timer must not fire a redundant clear afterwards.
    act(() => jest.advanceTimersByTime(4000));
    expect(restore).not.toHaveBeenCalled();
  });
});
