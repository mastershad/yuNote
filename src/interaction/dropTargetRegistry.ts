export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DropTargetRegistry {
  register(id: string, rect: Rect): void;
  unregister(id: string): void;
  hitTest(point: { x: number; y: number }): string | null;
}

function contains(rect: Rect, point: { x: number; y: number }): boolean {
  return point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;
}

export function createDropTargetRegistry(): DropTargetRegistry {
  const order: string[] = [];
  const rects = new Map<string, Rect>();

  return {
    register(id, rect) {
      if (!rects.has(id)) order.push(id);
      rects.set(id, rect);
    },
    unregister(id) {
      rects.delete(id);
      const index = order.indexOf(id);
      if (index !== -1) order.splice(index, 1);
    },
    hitTest(point) {
      for (let i = order.length - 1; i >= 0; i--) {
        const rect = rects.get(order[i]);
        if (rect && contains(rect, point)) return order[i];
      }
      return null;
    },
  };
}
