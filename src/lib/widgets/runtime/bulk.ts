/**
 * Bulk actions on a table view: which selected rows an action can run on, and the selection helpers the table uses.
 * Kept apart from React so the rules can be tested. Pure (no I/O).
 *
 * A view names its bulk actions with `bulk: ["remove", "stop"]`; each must also be one of the view's `rowActions`. The
 * person still needs the action's permission, and the action's `when` decides which selected rows it applies to.
 */
import { evalCond, fillTemplate, type Cond, type ViewSpec } from './spec';

export type BulkRow = Record<string, unknown>;

/** What the bulk logic needs from an action: the same public shape the table already gets. */
export interface BulkActionLike {
  id: string;
  label: string;
  kind?: string;
  when?: Cond;
  confirm?: { destructive?: boolean };
  /** A resource target, or a parameter taken from a row field: how the action aims at one row. */
  target?: unknown;
  params?: Record<string, { from?: string }>;
}

/** A stable identity for a row, so a selection survives a sort or a filter change. */
export const rowKey = (row: BulkRow): string => JSON.stringify(row);

/** The name a row shows in a bulk confirmation: the list title, else the first table column. */
export function rowLabel(view: ViewSpec, row: BulkRow): string {
  const template = view.row?.title ?? view.columns?.[0]?.value;
  return template ? fillTemplate(template, row) : '';
}

/**
 * Can this action run on this row? Screens and terminals are not bulk actions: a screen opens a dialog and a terminal
 * needs a person at the keyboard. The action must also aim at a row (a target, or a parameter taken from a row field),
 * and its `when` condition must hold, exactly as for a single row action.
 */
export function actionRunsOnRow(action: BulkActionLike, row: BulkRow): boolean {
  if (action.kind === 'screen' || action.kind === 'terminal') return false;
  if (!action.target && !Object.values(action.params ?? {}).some(p => p.from)) return false;
  return !action.when || evalCond(action.when, row);
}

export interface BulkCandidate<A> {
  action: A;
  /** The selected rows the action applies to. */
  rows: BulkRow[];
  /** Selected rows the action does not apply to (a stopped container for Stop, for example). */
  skipped: number;
}

/**
 * One entry per bulk action the person may run on at least one selected row, in the order the view names them. Rows are
 * kept in their displayed order. `actions` and `allowed` are the same ones the table uses for a single row action.
 */
export function bulkCandidates<A extends BulkActionLike>(
  view: ViewSpec,
  rows: BulkRow[],
  selected: ReadonlySet<string>,
  actions: ReadonlyMap<string, A>,
  allowed: (action: A) => boolean,
): BulkCandidate<A>[] {
  const picked = rows.filter(row => selected.has(rowKey(row)));
  const out: BulkCandidate<A>[] = [];
  for (const id of view.bulk ?? []) {
    const action = actions.get(id);
    if (!action || !allowed(action)) continue;
    const eligible = picked.filter(row => actionRunsOnRow(action, row));
    if (eligible.length > 0) out.push({ action, rows: eligible, skipped: picked.length - eligible.length });
  }
  return out;
}

/** Add or remove one row from a selection. */
export function toggleSelected(selected: ReadonlySet<string>, key: string, on: boolean): Set<string> {
  const next = new Set(selected);
  if (on) next.add(key); else next.delete(key);
  return next;
}

/** Select or clear every row of `rows` (the visible, filtered rows), leaving any other selection untouched. */
export function selectAll(selected: ReadonlySet<string>, rows: BulkRow[], on: boolean): Set<string> {
  const next = new Set(selected);
  for (const row of rows) {
    const key = rowKey(row);
    if (on) next.add(key); else next.delete(key);
  }
  return next;
}

/** The rows of `rows` that are selected, in display order. */
export const selectedRows = (rows: BulkRow[], selected: ReadonlySet<string>): BulkRow[] =>
  rows.filter(row => selected.has(rowKey(row)));

/** The names a bulk confirmation lists: the first `max`, then how many were left out. */
export function bulkNames(view: ViewSpec, rows: BulkRow[], max = 10): { names: string[]; more: number } {
  const all = rows.map(row => rowLabel(view, row));
  return { names: all.slice(0, max), more: Math.max(0, all.length - max) };
}
