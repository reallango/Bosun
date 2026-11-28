/**
 * Arrangement of a `stat` or `gauges` block inside a widget: how many columns and rows its items take so each cell is as
 * large as it can be. Only the divisors of the item count are candidates (rows = items / columns), so every row holds the
 * same number of items and no row is left half empty. Pure (no I/O), so the choice can be tested on its own.
 */
import { TILE_FIT_CQW, TILE_VALUE_FLOOR_REM, type MinItemWidth } from './sizing';

export type ArrangementKind = 'stat' | 'gauges';

export interface Arrangement {
  cols: number;
  rows: number;
  /** The width of one cell in px: the box less the gaps, shared out. */
  cellWidth: number;
  /** The height of one cell in px. */
  cellHeight: number;
}

export interface ArrangementOptions {
  /** The block's `minItemWidth` as a lower bound for a cell, in px. */
  minItemWidth?: number;
  /** The widest value of the block in characters, so a tile is never narrower than that value at the readable floor. */
  valueChars?: number;
}

/** A `minItemWidth` in px (the rem values the fallback grid used, at 16px per rem). */
export const MIN_ITEM_WIDTH_PX: Record<MinItemWidth, number> = { xs: 88, sm: 112, md: 136, lg: 168 };

/** A stat tile reads best a little wider than it is tall. */
export const TARGET_TILE_ASPECT = 1.4;

/** How strongly a cell whose aspect is away from the target loses score (1 = a factor of 1 + |ln ratio|). */
const ASPECT_PENALTY = 1;

/** The card's horizontal padding (p-2.5) around a tile's value, in px. */
const TILE_PADDING_PX = 20;

/** CSS `rem` is 16px in this app (sizing.ts uses the same). */
const ROOT_FONT_PX = 16;

const EPSILON = 1e-9;

/** The divisors of `n`, ascending: the possible column counts of a balanced grid. */
export function divisors(n: number): number[] {
  const out: number[] = [];
  for (let d = 1; d <= n; d++) if (n % d === 0) out.push(d);
  return out;
}

/**
 * The narrowest cell in which a tile's value of `chars` characters still reaches the readable floor without splitting
 * (see `tileFitCqw` in sizing.ts): the fit font at a cell of this width is exactly the floor.
 */
export function tileMinWidth(chars: number): number {
  if (!Number.isFinite(chars) || chars <= 0) return 0;
  return Math.ceil((chars * TILE_VALUE_FLOOR_REM * ROOT_FONT_PX * 100) / TILE_FIT_CQW) + TILE_PADDING_PX;
}

/** How good one candidate is for its kind: a ring wants a square cell, a tile wants area near the target aspect. */
function cellScore(kind: ArrangementKind, cellWidth: number, cellHeight: number): number {
  if (cellWidth <= 0 || cellHeight <= 0) return Number.NEGATIVE_INFINITY;
  if (kind === 'gauges') return Math.min(cellWidth, cellHeight);
  const aspect = cellWidth / cellHeight;
  return (cellWidth * cellHeight) / (1 + ASPECT_PENALTY * Math.abs(Math.log(aspect / TARGET_TILE_ASPECT)));
}

/**
 * The balanced arrangement of `n` items in a `width` x `height` box (px). `gap` is the space between cells, in px.
 *
 * Every candidate splits the items evenly, so each row has the same number of items. A candidate whose cells are too
 * narrow (below the block's `minItemWidth`, or below what a tile's value needs at the readable floor) is left out; if
 * every candidate is too narrow the widest one wins, since width is then the binding constraint. Equal scores go to the
 * arrangement with fewer rows, which uses the width first.
 */
export function balancedArrangement(n: number, width: number, height: number, kind: ArrangementKind, gap = 8, opts: ArrangementOptions = {}): Arrangement {
  const count = Math.max(1, Math.floor(n));
  const g = Math.max(0, gap);
  const boxWidth = Math.max(0, width);
  const boxHeight = Math.max(0, height);
  const candidates = divisors(count).map(cols => {
    const rows = count / cols;
    return {
      cols, rows,
      cellWidth: (boxWidth - g * (cols - 1)) / cols,
      cellHeight: (boxHeight - g * (rows - 1)) / rows,
    };
  });
  // Fewer rows first, so a tie keeps the wider arrangement.
  const ordered = [...candidates].sort((a, b) => a.rows - b.rows);
  const floor = Math.max(opts.minItemWidth ?? 0, kind === 'stat' ? tileMinWidth(opts.valueChars ?? 0) : 0);
  const eligible = ordered.filter(c => c.cellWidth >= floor && c.cellHeight > 0);
  if (!eligible.length) return ordered.reduce((best, c) => (c.cellWidth > best.cellWidth ? c : best));
  let best = eligible[0];
  let bestScore = cellScore(kind, best.cellWidth, best.cellHeight);
  for (const candidate of eligible.slice(1)) {
    const score = cellScore(kind, candidate.cellWidth, candidate.cellHeight);
    if (score > bestScore + EPSILON) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

/** The CSS grid template that lays the items out in `arrangement`. */
export function gridTemplate(arrangement: Arrangement): { gridTemplateColumns: string; gridTemplateRows: string } {
  return {
    gridTemplateColumns: `repeat(${arrangement.cols}, minmax(0, 1fr))`,
    gridTemplateRows: `repeat(${arrangement.rows}, minmax(0, 1fr))`,
  };
}
