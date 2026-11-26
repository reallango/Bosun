import { describe, it, expect } from 'vitest';
import { layoutForBreakpoint, GRID_COLS, applyLayoutEdit, applyLayoutEverywhere, resetLayoutAt, toBaseRect, hasOwnLayout } from './widget-sizes';
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

describe('one base layout that follows the last edit', () => {
  type Base = { grid_x: number; grid_y: number; grid_w: number; grid_h: number };
  const asSource = (id: string, r: ReturnType<typeof applyLayoutEdit>, prev: Base) => ({
    id,
    grid_x: r.grid?.x ?? prev.grid_x, grid_y: r.grid?.y ?? prev.grid_y, grid_w: r.grid?.w ?? prev.grid_w, grid_h: r.grid?.h ?? prev.grid_h,
    layouts: r.layouts,
  });

  it('leaves old data exactly as it was: lg shows grid_* when nothing was arranged on lg', () => {
    const items = layoutForBreakpoint(row, 'lg');
    expect(items.map(i => [i.x, i.y, i.w, i.h])).toEqual([[0, 0, 8, 5], [8, 0, 8, 5], [16, 0, 8, 5]]);
  });

  it('an edit on a large screen is saved for it and becomes the base the other sizes follow', () => {
    // Arranged on xl (30 columns): two widgets of 15 side by side.
    const a = applyLayoutEdit({}, 'xl', { x: 0, y: 0, w: 15, h: 6 });
    const b = applyLayoutEdit({}, 'xl', { x: 15, y: 0, w: 15, h: 6 });
    expect(a.layouts.xl).toEqual({ x: 0, y: 0, w: 15, h: 6 });
    expect(a.grid).toEqual({ x: 0, y: 0, w: 12, h: 6 });
    expect(b.grid).toEqual({ x: 12, y: 0, w: 12, h: 6 });
    const widgets = [asSource('a', a, row[0]), asSource('b', b, row[1])];
    // A laptop (lg) that was never arranged now shows the same split, and so does md.
    expect(layoutForBreakpoint(widgets, 'lg').map(i => [i.x, i.w])).toEqual([[0, 12], [12, 12]]);
    expect(layoutForBreakpoint(widgets, 'md').map(i => [i.x, i.w])).toEqual([[0, 10], [10, 10]]);
    expect(layoutForBreakpoint(widgets, 'xl').map(i => [i.x, i.w])).toEqual([[0, 15], [15, 15]]);
  });

  it('a size that was arranged keeps its own arrangement when another size is edited', () => {
    const onLaptop = applyLayoutEdit({}, 'lg', { x: 4, y: 0, w: 6, h: 4 });
    expect(onLaptop.layouts.lg).toEqual({ x: 4, y: 0, w: 6, h: 4 });
    const thenWide = applyLayoutEdit(onLaptop.layouts, 'xl', { x: 0, y: 0, w: 30, h: 4 });
    expect(thenWide.grid).toEqual({ x: 0, y: 0, w: 24, h: 4 });
    const w = { id: 'w', grid_x: 0, grid_y: 0, grid_w: 24, grid_h: 4, layouts: thenWide.layouts };
    expect(layoutForBreakpoint([w], 'lg')[0]).toMatchObject({ x: 4, w: 6 });
    expect(layoutForBreakpoint([w], 'md')[0]).toMatchObject({ x: 0, w: 20 });
  });

  it('phone edits only change the phone order', () => {
    const r = applyLayoutEdit({ xl: { x: 0, y: 0, w: 10, h: 4 } }, 'xxs', { x: 0, y: 7, w: 2, h: 4 });
    expect(r.grid).toBeUndefined();
    expect(r.layouts).toEqual({ xl: { x: 0, y: 0, w: 10, h: 4 }, xxs: { x: 0, y: 7, w: 2, h: 4 } });
  });

  it('reset drops one size, use-everywhere drops all others', () => {
    expect(resetLayoutAt({ xl: { x: 0, y: 0, w: 1, h: 1 }, md: { x: 0, y: 0, w: 1, h: 1 } }, 'xl')).toEqual({ md: { x: 0, y: 0, w: 1, h: 1 } });
    expect(applyLayoutEverywhere('sm', { x: 6, y: 2, w: 6, h: 3 })).toEqual({ grid: { x: 12, y: 2, w: 12, h: 3 }, layouts: { sm: { x: 6, y: 2, w: 6, h: 3 } } });
    expect(applyLayoutEverywhere('lg', { x: 1, y: 0, w: 5, h: 3 })).toEqual({ grid: { x: 1, y: 0, w: 5, h: 3 }, layouts: {} });
  });

  it('scaling to the base keeps neighbours touching and every widget at least one column wide', () => {
    const left = toBaseRect({ x: 0, y: 0, w: 7, h: 2 }, 20);
    const right = toBaseRect({ x: 7, y: 0, w: 13, h: 2 }, 20);
    expect(left.x + left.w).toBe(right.x);
    expect(right.x + right.w).toBe(24);
    expect(toBaseRect({ x: 29, y: 0, w: 1, h: 1 }, 30).w).toBeGreaterThanOrEqual(1);
    expect(hasOwnLayout([{ id: 'x', layouts: { md: { x: 0, y: 0, w: 1, h: 1 } } }], 'md')).toBe(true);
    expect(hasOwnLayout([{ id: 'x', grid_x: 0 }], 'lg')).toBe(false);
  });
});
