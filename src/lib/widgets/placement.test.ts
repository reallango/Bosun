import { describe, it, expect } from 'vitest';
import { findFreeSpot } from './placement';

describe('findFreeSpot', () => {
  it('starts at the origin on an empty grid', () => {
    expect(findFreeSpot([], 8, 6)).toEqual({ x: 0, y: 0 });
  });
  it('fills the row beside existing widgets before going down', () => {
    const a = { x: 0, y: 0, w: 8, h: 6 };
    expect(findFreeSpot([a], 8, 6)).toEqual({ x: 8, y: 0 });
    expect(findFreeSpot([a, { x: 8, y: 0, w: 8, h: 6 }], 8, 6)).toEqual({ x: 16, y: 0 });
    expect(findFreeSpot([a, { x: 8, y: 0, w: 16, h: 4 }], 12, 6)).toEqual({ x: 8, y: 4 });
  });
  it('goes below when nothing fits and clamps oversized widths', () => {
    expect(findFreeSpot([{ x: 0, y: 0, w: 20, h: 3 }], 8, 2)).toEqual({ x: 0, y: 3 });
    expect(findFreeSpot([], 40, 2)).toEqual({ x: 0, y: 0 });
  });
});
