/**
 * Client-side sorting for a table view (spec key `sort` on a column, `defaultSort` on the view). Only the rows the widget
 * already has are ordered; nothing is asked of the host. Pure, no React.
 */
import { getPath } from './spec';

export const SORT_DIRS = ['asc', 'desc'] as const;
export type SortDir = (typeof SORT_DIRS)[number];

export interface SortState {
  /** The raw row field to sort by (a column's `sort`). */
  field: string;
  dir: SortDir;
}

const number = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const asText = (v: unknown): string => (v === undefined || v === null ? '' : String(v).toLowerCase());

/**
 * Compare two row values: numerically when both are numbers, otherwise as case-insensitive text (so ISO dates, which are
 * fixed width and zero-padded, order chronologically as text).
 */
export function compareForSort(a: unknown, b: unknown): number {
  const na = number(a);
  const nb = number(b);
  if (na !== null && nb !== null) return na - nb;
  const sa = asText(a);
  const sb = asText(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/** A copy of `rows` ordered by `field` in direction `dir` (stable: equal values keep their order). */
export function sortRows<T>(rows: T[], field: string, dir: SortDir): T[] {
  const out = rows.slice();
  out.sort((a, b) => {
    const c = compareForSort(getPath(a, field), getPath(b, field));
    return dir === 'asc' ? c : -c;
  });
  return out;
}

/** The direction a header click gives: a fresh column starts ascending, the same column flips. */
export function nextSortDir(current: SortDir | null): SortDir {
  return current === 'asc' ? 'desc' : 'asc';
}
