/**
 * How the number of a stat tile or a ring gauge is written. A template turns both a number and a numeric string into
 * text, so the rules work on text. Pure (no I/O), so they can be tested on their own.
 */

/** The most decimals an item may ask for. */
export const MAX_DECIMALS = 3;

/** The text of exactly one finite number ("89.9", " -3 ", "1e3"), or null for anything else. */
export function numberOf(raw: string): number | null {
  const t = raw.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** A number with at most `decimals` decimals, without a trailing ".0" ("89.9", "100", "0.8"). */
export function formatNumber(n: number, decimals: number): string {
  const d = Math.max(0, Math.min(MAX_DECIMALS, Math.trunc(decimals)));
  const rounded = Math.round((n + Number.EPSILON) * 10 ** d) / 10 ** d;
  const fixed = (Object.is(rounded, -0) ? 0 : rounded).toFixed(d);
  return d > 0 && fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed;
}

/**
 * A percentage: at most `decimals` decimals (default 1), and a whole number from 100 up, so a full ring reads
 * "100%" and never "100.0%". Rounding can reach 100 (99.99), which is written whole too.
 */
export function formatPercent(n: number, decimals = 1): string {
  const d = Math.max(0, Math.min(MAX_DECIMALS, Math.trunc(decimals)));
  const rounded = Math.round((n + Number.EPSILON) * 10 ** d) / 10 ** d;
  return formatNumber(rounded, Math.abs(rounded) >= 100 ? 0 : d);
}

/**
 * The text of a value for a tile or a gauge, before its unit is appended. A number with a `%` unit gets at most one
 * decimal unless the item asks for another count; any other value is left exactly as the template gave it.
 */
export function formatValueText(raw: string, unit: string | undefined, decimals: number | undefined): string {
  const n = numberOf(raw);
  if (n === null) return raw;
  const percent = !!unit && unit.trim().startsWith('%');
  if (percent) return formatPercent(n, decimals ?? 1);
  return decimals === undefined ? raw : formatNumber(n, decimals);
}

/** A value with its unit: "%" and "°C" sit tight, other units take a space. */
export function withUnit(value: string, unit: string | undefined): string {
  if (!unit || !value) return value;
  return unit.startsWith('%') || unit.startsWith('°') ? `${value}${unit}` : `${value} ${unit}`;
}
