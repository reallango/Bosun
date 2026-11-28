import { describe, it, expect } from 'vitest';
import {
  balancedArrangement, divisors, gridTemplate, MIN_ITEM_WIDTH_PX, TARGET_TILE_ASPECT, tileMinWidth,
  type Arrangement, type ArrangementKind,
} from './arrangement';

const WIDE = { width: 800, height: 200 };
const SQUARE = { width: 400, height: 400 };
const TALL = { width: 200, height: 800 };

const box = (a: Arrangement): string => `${a.cols}x${a.rows}`;
const arrange = (n: number, b: { width: number; height: number }, kind: ArrangementKind): Arrangement =>
  balancedArrangement(n, b.width, b.height, kind, 8);

describe('divisors', () => {
  it('lists the possible column counts of a balanced grid, ascending', () => {
    expect(divisors(1)).toEqual([1]);
    expect(divisors(2)).toEqual([1, 2]);
    expect(divisors(6)).toEqual([1, 2, 3, 6]);
    expect(divisors(12)).toEqual([1, 2, 3, 4, 6, 12]);
    expect(divisors(7)).toEqual([1, 7]);
  });
});

describe('the arrangement of a stat or gauge block', () => {
  // Wide is 4:1, square is 1:1 and tall is 1:4. Every row of every result holds the same number of items.
  const cases: { n: number; kind: ArrangementKind; wide: string; square: string; tall: string }[] = [
    { n: 2, kind: 'gauges', wide: '2x1', square: '2x1', tall: '1x2' },
    { n: 2, kind: 'stat', wide: '2x1', square: '1x2', tall: '1x2' },
    { n: 3, kind: 'gauges', wide: '3x1', square: '3x1', tall: '1x3' },
    { n: 3, kind: 'stat', wide: '3x1', square: '1x3', tall: '1x3' },
    { n: 4, kind: 'gauges', wide: '4x1', square: '2x2', tall: '1x4' },
    { n: 4, kind: 'stat', wide: '4x1', square: '2x2', tall: '1x4' },
    { n: 5, kind: 'gauges', wide: '5x1', square: '5x1', tall: '1x5' },
    { n: 5, kind: 'stat', wide: '5x1', square: '1x5', tall: '1x5' },
    { n: 6, kind: 'gauges', wide: '6x1', square: '3x2', tall: '1x6' },
    { n: 6, kind: 'stat', wide: '3x2', square: '2x3', tall: '1x6' },
    { n: 8, kind: 'gauges', wide: '4x2', square: '4x2', tall: '2x4' },
    { n: 8, kind: 'stat', wide: '4x2', square: '2x4', tall: '1x8' },
    { n: 12, kind: 'gauges', wide: '6x2', square: '4x3', tall: '2x6' },
    { n: 12, kind: 'stat', wide: '6x2', square: '3x4', tall: '2x6' },
  ];

  for (const c of cases) {
    it(`puts ${c.n} ${c.kind} items in balanced rows`, () => {
      expect(box(arrange(c.n, WIDE, c.kind))).toBe(c.wide);
      expect(box(arrange(c.n, SQUARE, c.kind))).toBe(c.square);
      expect(box(arrange(c.n, TALL, c.kind))).toBe(c.tall);
    });
  }

  it('never leaves a row half empty', () => {
    for (const kind of ['stat', 'gauges'] as const) {
      for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 16]) {
        for (const b of [WIDE, SQUARE, TALL, { width: 320, height: 240 }, { width: 240, height: 320 }]) {
          const a = arrange(n, b, kind);
          expect(a.cols * a.rows).toBe(n);
          expect(n % a.cols).toBe(0);
        }
      }
    }
  });

  it('keeps a prime count in a single row or a single column', () => {
    for (const kind of ['stat', 'gauges'] as const) {
      for (const n of [5, 7]) {
        for (const b of [WIDE, SQUARE, TALL]) {
          const a = arrange(n, b, kind);
          expect([1, n]).toContain(a.cols);
        }
      }
    }
  });

  it('stacks a tall, narrow two-gauge widget and keeps a wide one side by side', () => {
    expect(box(balancedArrangement(2, 240, 600, 'gauges', 8))).toBe('1x2');
    expect(box(balancedArrangement(2, 600, 240, 'gauges', 8))).toBe('2x1');
  });

  it('breaks a tie towards fewer rows', () => {
    // A 400 x 400 box leaves 3x2 and 2x3 with the same min(cellWidth, cellHeight) for rings: 128px each.
    expect(box(arrange(6, SQUARE, 'gauges'))).toBe('3x2');
  });

  it('reports the cell size the box and the gap leave', () => {
    const a = arrange(4, WIDE, 'gauges');
    expect(a.cellWidth).toBeCloseTo((800 - 3 * 8) / 4);
    expect(a.cellHeight).toBe(200);
    const gapped = balancedArrangement(4, 800, 200, 'gauges', 24);
    expect(gapped.cellWidth).toBeCloseTo((800 - 3 * 24) / 4);
  });

  it('takes a wider box before a taller cell', () => {
    expect(TARGET_TILE_ASPECT).toBeGreaterThan(1);
    // The same area, one arrangement with cells wider than tall: the tile prefers it.
    expect(box(balancedArrangement(2, 400, 400, 'stat', 8))).toBe('1x2');
    expect(box(balancedArrangement(2, 400, 400, 'gauges', 8))).toBe('2x1');
  });
});

describe('the lower bounds of a tile', () => {
  it('gives the width a value needs at the readable floor', () => {
    expect(tileMinWidth(0)).toBe(0);
    expect(tileMinWidth(5)).toBe(72);
    expect(tileMinWidth(10)).toBe(123);
    expect(tileMinWidth(14)).toBe(164);
  });

  it('drops a candidate below the block\'s minItemWidth', () => {
    // Four tiles fit in one row of 119px cells; a 168px minimum leaves only the 2x2 arrangement.
    expect(box(arrange(4, { width: 500, height: 120 }, 'stat'))).toBe('4x1');
    expect(box(balancedArrangement(4, 500, 120, 'stat', 8, { minItemWidth: MIN_ITEM_WIDTH_PX.lg }))).toBe('2x2');
    expect(MIN_ITEM_WIDTH_PX).toEqual({ xs: 88, sm: 112, md: 136, lg: 168 });
  });

  it('drops a candidate too narrow for the block\'s widest value', () => {
    // A 10-character value needs 123px: three tiles in one row of 94px cells would be unreadable.
    expect(box(arrange(4, { width: 500, height: 100 }, 'stat'))).toBe('4x1');
    expect(box(balancedArrangement(4, 500, 100, 'stat', 8, { valueChars: 10 }))).toBe('2x2');
    expect(box(balancedArrangement(3, 200, 200, 'stat', 8, { valueChars: 14 }))).toBe('1x3');
  });

  it('falls back to the widest arrangement when even one column is too narrow', () => {
    expect(box(balancedArrangement(4, 60, 400, 'stat', 8, { minItemWidth: MIN_ITEM_WIDTH_PX.lg }))).toBe('1x4');
    expect(box(balancedArrangement(6, 60, 400, 'stat', 8, { valueChars: 20 }))).toBe('1x6');
  });

  it('ignores the value floor for rings, which are square', () => {
    expect(box(balancedArrangement(4, 500, 100, 'gauges', 8, { valueChars: 10 }))).toBe('4x1');
  });
});

describe('degenerate boxes', () => {
  it('handles a single item and no items', () => {
    expect(box(balancedArrangement(1, 400, 200, 'stat'))).toBe('1x1');
    expect(box(balancedArrangement(0, 400, 200, 'stat'))).toBe('1x1');
  });

  it('returns a single column before the box is measured', () => {
    expect(box(balancedArrangement(4, 0, 0, 'stat'))).toBe('1x4');
    expect(box(balancedArrangement(4, 0, 300, 'stat'))).toBe('1x4');
    expect(box(balancedArrangement(4, 300, 0, 'stat'))).toBe('1x4');
  });
});

describe('the grid template', () => {
  it('follows the arrangement', () => {
    expect(gridTemplate({ cols: 3, rows: 2, cellWidth: 100, cellHeight: 100 })).toEqual({
      gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
      gridTemplateRows: 'repeat(2, minmax(0, 1fr))',
    });
    expect(gridTemplate(arrange(6, WIDE, 'gauges'))).toEqual({
      gridTemplateColumns: 'repeat(6, minmax(0, 1fr))',
      gridTemplateRows: 'repeat(1, minmax(0, 1fr))',
    });
  });
});
