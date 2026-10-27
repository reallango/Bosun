import { describe, it, expect } from 'vitest';
import { layoutForBreakpoint, GRID_COLS } from './widget-sizes';
import type { GridBreakpoint } from '@/types/dashboard';

const row = [0, 8, 16].map((x, i) => ({ id: `w${i}`, grid_x: x, grid_y: 0, grid_w: 8, grid_h: 5, grid_min_w: 2, grid_min_h: 2 }));

describe('layoutForBreakpoint', () => {
  it('keeps a full lg row side by side without overlaps on every multi-column breakpoint', () => {
    for (const bp of ['xxl', 'xl', 'md', 'sm'] as GridBreakpoint[]) {
      const items = layoutForBreakpoint(row, bp);
      const sorted = [...items].sort((a, b) => a.x - b.x);
      for (let i = 1; i < sorted.length; i++) {
        expect(sorted[i].x, `${bp} overlap`).toBeGreaterThanOrEqual(sorted[i - 1].x + sorted[i - 1].w);
      }
      expect(sorted.every(it => it.y === 0)).toBe(true);
      const last = sorted[sorted.length - 1];
      expect(last.x + last.w).toBeLessThanOrEqual(GRID_COLS[bp]);
    }
  });
  it('stacks widgets full width on phones', () => {
    const items = layoutForBreakpoint(row, 'xxs');
    expect(items.map(i => [i.x, i.w])).toEqual([[0, GRID_COLS.xxs], [0, GRID_COLS.xxs], [0, GRID_COLS.xxs]]);
    expect(items.map(i => i.y)).toEqual([0, 5, 10]);
  });
});
