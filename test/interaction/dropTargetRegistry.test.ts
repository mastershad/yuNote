import { createDropTargetRegistry } from '../../src/interaction/dropTargetRegistry';

describe('dropTargetRegistry', () => {
  it('hitTest returns the id of the rect containing the point', () => {
    const registry = createDropTargetRegistry();
    registry.register('a', { x: 0, y: 0, width: 100, height: 100 });
    registry.register('b', { x: 200, y: 0, width: 100, height: 100 });

    expect(registry.hitTest({ x: 50, y: 50 })).toBe('a');
    expect(registry.hitTest({ x: 250, y: 50 })).toBe('b');
  });

  it('hitTest returns null when the point is outside every registered rect', () => {
    const registry = createDropTargetRegistry();
    registry.register('a', { x: 0, y: 0, width: 100, height: 100 });

    expect(registry.hitTest({ x: 500, y: 500 })).toBeNull();
  });

  it('unregister removes a rect from consideration', () => {
    const registry = createDropTargetRegistry();
    registry.register('a', { x: 0, y: 0, width: 100, height: 100 });
    registry.unregister('a');

    expect(registry.hitTest({ x: 50, y: 50 })).toBeNull();
  });

  it('re-registering the same id replaces its rect rather than duplicating it', () => {
    const registry = createDropTargetRegistry();
    registry.register('a', { x: 0, y: 0, width: 100, height: 100 });
    registry.register('a', { x: 200, y: 200, width: 100, height: 100 });

    expect(registry.hitTest({ x: 50, y: 50 })).toBeNull();
    expect(registry.hitTest({ x: 250, y: 250 })).toBe('a');
  });

  it('when two rects overlap, hitTest returns the most recently registered one', () => {
    const registry = createDropTargetRegistry();
    registry.register('a', { x: 0, y: 0, width: 100, height: 100 });
    registry.register('b', { x: 50, y: 50, width: 100, height: 100 });

    expect(registry.hitTest({ x: 75, y: 75 })).toBe('b');
  });
});
