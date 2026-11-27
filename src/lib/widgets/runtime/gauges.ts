/**
 * Ring gauges: the items of a `gauges` block and the geometry of a ring. The ring is drawn in a 100 x 100 viewBox, so
 * the renderer only needs a radius and a dash offset. Pure (no I/O).
 */
import { fail, isObj, text, type Validated } from './spec-util';
import { validateDecimals, validateEmphasis, validateGaugeThickness, type Emphasis, type GaugeThickness } from './sizing';
import { validateThresholds, type Thresholds } from './thresholds';

export const GAUGE_VIEWBOX = 100;
export const GAUGE_STROKE = 10;

/** Ring stroke widths in the 100-unit viewBox. */
export const GAUGE_STROKES: Record<GaugeThickness, number> = { thin: 6, normal: GAUGE_STROKE, thick: 16 };

/** The stroke a ring draws with (normal when it does not say). */
export const gaugeStroke = (thickness: GaugeThickness | undefined): number => GAUGE_STROKES[thickness ?? 'normal'];

export interface GaugeItem {
  label: string;
  /** A template over the screen's context that gives the value. */
  value: string;
  /** The value a full ring stands for (default 100). */
  max?: number;
  unit?: string;
  thresholds?: Thresholds;
  sub?: string;
  /** How many decimals the value shows (0-3); a `%` value defaults to at most one. */
  decimals?: number;
  /** `muted` dims a secondary item's value. */
  emphasis?: Emphasis;
  /** The ring stroke, overriding the block's `thickness`. */
  thickness?: GaugeThickness;
}

/** Validate one item of a `gauges` block. */
export function validateGaugeItem(raw: unknown, where: string): Validated<GaugeItem> {
  if (!isObj(raw)) return fail(`${where}: each gauge must be an object`);
  const label = text(raw.label, 40);
  const value = text(raw.value, 200);
  if (!label || !value) return fail(`${where}: each gauge needs a "label" and a "value"`);
  let max: number | undefined;
  if (raw.max !== undefined) {
    if (typeof raw.max !== 'number' || !Number.isFinite(raw.max) || raw.max <= 0) return fail(`${where}: gauge "${label}": "max" must be a number above 0`);
    max = raw.max;
  }
  const unit = raw.unit === undefined ? undefined : text(raw.unit, 8);
  if (unit === null) return fail(`${where}: gauge "${label}": "unit" must be short text`);
  const sub = raw.sub === undefined ? undefined : text(raw.sub, 200);
  if (sub === null) return fail(`${where}: gauge "${label}": "sub" must be text`);
  const thresholds = validateThresholds(raw.thresholds, `${where} gauge "${label}"`);
  if (!thresholds.ok) return thresholds;
  const decimals = validateDecimals(raw.decimals, `${where} gauge "${label}"`);
  if (!decimals.ok) return decimals;
  const emphasis = validateEmphasis(raw.emphasis, `${where} gauge "${label}"`);
  if (!emphasis.ok) return emphasis;
  const thickness = validateGaugeThickness(raw.thickness, `${where} gauge "${label}"`);
  if (!thickness.ok) return thickness;
  return {
    ok: true,
    value: {
      label, value, ...(max !== undefined ? { max } : {}), ...(unit ? { unit } : {}),
      ...(thresholds.value ? { thresholds: thresholds.value } : {}), ...(sub ? { sub } : {}),
      ...(decimals.value !== undefined ? { decimals: decimals.value } : {}),
      ...(emphasis.value ? { emphasis: emphasis.value } : {}),
      ...(thickness.value ? { thickness: thickness.value } : {}),
    },
  };
}

export interface GaugeGeometry {
  /** How full the ring is, 0-100. */
  pct: number;
  cx: number;
  cy: number;
  r: number;
  circumference: number;
  /** How much of the ring is left undrawn (for `stroke-dashoffset`). */
  dashOffset: number;
}

/** The geometry of one ring. Values outside 0-max are clamped; a value that is not a number draws an empty ring. */
export function gaugeGeometry(value: unknown, max = 100, size = GAUGE_VIEWBOX, stroke = GAUGE_STROKE): GaugeGeometry {
  const n = typeof value === 'number' ? value : Number(value);
  const pct = Number.isFinite(n) && max > 0 ? Math.max(0, Math.min(100, (n / max) * 100)) : 0;
  const r = Math.max(0, (size - stroke) / 2);
  const circumference = 2 * Math.PI * r;
  return { pct, cx: size / 2, cy: size / 2, r, circumference, dashOffset: circumference * (1 - pct / 100) };
}
