/**
 * Stat tiles: which tone a tile takes. A tone is either fixed (`"warning"`) or a map of tones to conditions; the first
 * tone whose condition holds (in the order the spec gives) wins. Pure (no I/O), so the rule can be tested.
 */
import { evalCond, getPath } from './spec';
import type { StatCount, StatItem, StatTone } from './spec-v2';
import type { ViewContext } from './layout';

export function statTone(tone: StatItem['tone'], ctx: ViewContext): StatTone | null {
  if (!tone) return null;
  if (typeof tone === 'string') return tone;
  for (const [name, condition] of Object.entries(tone)) {
    if (condition && evalCond(condition, ctx)) return name as StatTone;
  }
  return null;
}

/**
 * The number a `count` tile shows: the length of the list at `path` (default: the widget's data), or of the rows
 * matching `where`. A missing list counts as no rows.
 */
export function countRows(count: StatCount, ctx: ViewContext): number {
  const base = count.path ? getPath(ctx, count.path) : ctx.data;
  const rows = Array.isArray(base) ? base : base === null || base === undefined ? [] : [base];
  return count.where ? rows.filter(row => evalCond(count.where!, row)).length : rows.length;
}

export { withUnit } from './number-format';
