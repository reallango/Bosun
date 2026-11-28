/**
 * Meter rows: a compact list of one bar or small ring per row of a data list (mounts, GPUs, interfaces). The block names
 * a path to the list and one template per row field, so a widget never needs code for its own list. Pure (no I/O), so the
 * validation and the per-row numbers can be tested on their own.
 */
import { fail, cond, FIELD_RE, isObj, text, type Validated } from './spec-util';
import { validateDecimals, validateEmphasis, type Emphasis } from './sizing';
import { validateThresholds, thresholdTone, type ThresholdTone, type Thresholds } from './thresholds';
import { formatValueText, withUnit } from './number-format';
import { evalCond, fillTemplate, type Cond } from './spec';

export const METER_SHAPES = ['bar', 'ring'] as const;
export type MeterShape = (typeof METER_SHAPES)[number];

/** `rows`: one row per item; `grid`: a dense grid of small meters (one per CPU core, for example). */
export const METER_LAYOUTS = ['rows', 'grid'] as const;
export type MeterLayout = (typeof METER_LAYOUTS)[number];

/** One row template of a `meters` block: the templates are filled from the row at `path`. */
export interface MeterItem {
  label: string;
  value: string;
  /** What a full bar or ring stands for (default 100). */
  max?: number;
  unit?: string;
  sub?: string;
  thresholds?: Thresholds;
  /** How many decimals the value shows (0-3); a `%` value defaults to at most one. */
  decimals?: number;
  /** `muted` dims a secondary value. */
  emphasis?: Emphasis;
  /** Level 11: draw the row only while this condition holds (read against the row). */
  when?: Cond;
}

export interface MetersSpec {
  /** Where the rows come from: a path into the widget's data (default: the data itself). */
  path?: string;
  shape: MeterShape;
  /** `rows` (default) or `grid` (many small meters in columns). */
  layout: MeterLayout;
  item: MeterItem;
  empty?: string;
}

/** Validate one row template of a `meters` block. */
export function validateMeterItem(raw: unknown, where: string): Validated<MeterItem> {
  if (!isObj(raw)) return fail(`${where}: "item" must be an object like {"label": "{name}", "value": "{usage}"}`);
  const label = text(raw.label, 200);
  const value = text(raw.value, 200);
  if (!label || !value) return fail(`${where}: "item" needs a "label" and a "value" template`);
  let max: number | undefined;
  if (raw.max !== undefined) {
    if (typeof raw.max !== 'number' || !Number.isFinite(raw.max) || raw.max <= 0) return fail(`${where}: "item.max" must be a number above 0`);
    max = raw.max;
  }
  const unit = raw.unit === undefined ? undefined : text(raw.unit, 8);
  if (unit === null) return fail(`${where}: "item.unit" must be short text`);
  const sub = raw.sub === undefined ? undefined : text(raw.sub, 200);
  if (sub === null) return fail(`${where}: "item.sub" must be text`);
  const thresholds = validateThresholds(raw.thresholds, `${where} item`);
  if (!thresholds.ok) return thresholds;
  const decimals = validateDecimals(raw.decimals, `${where} item`);
  if (!decimals.ok) return decimals;
  const emphasis = validateEmphasis(raw.emphasis, `${where} item`);
  if (!emphasis.ok) return emphasis;
  let when: Cond | undefined;
  if (raw.when !== undefined) {
    const c = cond(raw.when, `${where} item "when"`);
    if (!c.ok) return c;
    when = c.value;
  }
  return {
    ok: true,
    value: {
      label, value, ...(max !== undefined ? { max } : {}), ...(unit ? { unit } : {}), ...(sub ? { sub } : {}),
      ...(thresholds.value ? { thresholds: thresholds.value } : {}),
      ...(decimals.value !== undefined ? { decimals: decimals.value } : {}),
      ...(emphasis.value ? { emphasis: emphasis.value } : {}),
      ...(when ? { when } : {}),
    },
  };
}

/** Validate a `meters` block: its path, shape, row template and empty text. */
export function validateMeters(raw: Record<string, unknown>, where: string): Validated<Omit<MetersSpec, 'item'> & { item: MeterItem }> {
  let path: string | undefined;
  if (raw.path !== undefined) {
    if (typeof raw.path !== 'string' || !FIELD_RE.test(raw.path)) return fail(`${where}: "path" must be a dotted path into the widget's data`);
    path = raw.path;
  }
  let shape: MeterShape = 'bar';
  if (raw.shape !== undefined) {
    if (typeof raw.shape !== 'string' || !(METER_SHAPES as readonly string[]).includes(raw.shape)) {
      return fail(`${where}: "shape" must be one of ${METER_SHAPES.join(', ')}`);
    }
    shape = raw.shape as MeterShape;
  }
  let layout: MeterLayout = 'rows';
  if (raw.layout !== undefined) {
    if (typeof raw.layout !== 'string' || !(METER_LAYOUTS as readonly string[]).includes(raw.layout)) {
      return fail(`${where}: "layout" must be one of ${METER_LAYOUTS.join(', ')}`);
    }
    layout = raw.layout as MeterLayout;
  }
  const item = validateMeterItem(raw.item, where);
  if (!item.ok) return item;
  const empty = raw.empty === undefined ? undefined : text(raw.empty, 80);
  if (empty === null) return fail(`${where}: "empty" must be short text`);
  return { ok: true, value: { ...(path ? { path } : {}), shape, layout, item: item.value, ...(empty ? { empty } : {}) } };
}

/** The rows a `meters` block draws: the array at `path` (an object becomes one row; nothing becomes no rows). */
export function meterRows(source: unknown): Record<string, unknown>[] {
  if (Array.isArray(source)) return source.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object');
  if (source && typeof source === 'object') return [source as Record<string, unknown>];
  return [];
}

/** The rows a `meters` block draws after its item's `when`: a row whose condition does not hold is left out. */
export function visibleMeterRows(item: MeterItem, source: unknown): Record<string, unknown>[] {
  const rows = meterRows(source);
  return item.when ? rows.filter(row => evalCond(item.when!, row)) : rows;
}

export interface MeterRowView {
  label: string;
  sub?: string;
  valueText: string;
  /** How full the bar or ring is, 0-100. */
  pct: number;
  tone: ThresholdTone | null;
  emphasis: Emphasis;
}

/** What one row shows: its templates filled, its value written and how full its bar or ring is. */
export function meterRowView(item: MeterItem, row: unknown): MeterRowView {
  const rawValue = fillTemplate(item.value, row);
  const n = Number(rawValue);
  const max = item.max ?? 100;
  const pct = Number.isFinite(n) && max > 0 ? Math.max(0, Math.min(100, (n / max) * 100)) : 0;
  const number = formatValueText(rawValue, item.unit, item.decimals) || '—';
  return {
    label: fillTemplate(item.label, row) || '—',
    ...(item.sub ? { sub: fillTemplate(item.sub, row) } : {}),
    valueText: withUnit(number, item.unit),
    pct,
    tone: thresholdTone(n, item.thresholds),
    emphasis: item.emphasis ?? 'normal',
  };
}
