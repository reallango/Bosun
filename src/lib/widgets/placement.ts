export interface Rect { x: number; y: number; w: number; h: number }

/**
 * First free position for a w×h widget on a `cols`-wide grid, scanning rows
 * top to bottom and columns left to right, so new widgets fill gaps beside
 * existing ones instead of always stacking at x = 0.
 */
export function findFreeSpot(existing: Rect[], w: number, h: number, cols = 24): { x: number; y: number } {
  const width = Math.min(Math.max(1, w), cols);
  const overlaps = (x: number, y: number) =>
    existing.some(r => x < r.x + r.w && x + width > r.x && y < r.y + r.h && y + h > r.y);
  const bottom = existing.reduce((m, r) => Math.max(m, r.y + r.h), 0);
  for (let y = 0; y <= bottom; y++) {
    for (let x = 0; x + width <= cols; x++) {
      if (!overlaps(x, y)) return { x, y };
    }
  }
  return { x: 0, y: bottom };
}
