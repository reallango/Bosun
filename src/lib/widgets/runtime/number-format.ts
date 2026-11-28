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

/** The formats a stat tile or a ring gauge may apply to its value (the same names the list and table views use). */
export const VALUE_FORMATS = ['text', 'percent', 'bytes', 'rate', 'mb', 'temp', 'duration', 'ago', 'until'] as const;
export type ValueFormat = (typeof VALUE_FORMATS)[number];

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/** A byte count in the largest unit that keeps it readable ("1.5 GB"). */
export function formatBytes(n: number): string {
  let x = n;
  let i = 0;
  while (x >= 1024 && i < BYTE_UNITS.length - 1) { x /= 1024; i++; }
  return `${x >= 10 || i === 0 ? Math.round(x) : x.toFixed(1)} ${BYTE_UNITS[i]}`;
}

/**
 * How a labelled value is written: a byte count, a rate, megabytes, a temperature, a duration, a relative time or a
 * percentage. A value that is not a number is returned as text, so a template that gives a word still shows it.
 */
export function formatValue(v: unknown, format: string): string {
  if (v === undefined || v === null || v === '') return '';
  const n = Number(v);
  if (format === 'bytes' && Number.isFinite(n)) return formatBytes(n);
  if (format === 'rate' && Number.isFinite(n)) return `${formatBytes(n)}/s`;
  if ((format === 'percent' || format === 'bar') && Number.isFinite(n)) return `${formatPercent(n)}%`;
  if (format === 'mb' && Number.isFinite(n)) return n >= 1024 ? `${(n / 1024).toFixed(1)} GB` : `${Math.round(n)} MB`;
  if (format === 'temp' && Number.isFinite(n)) return `${Math.round(n)}°C`;
  if (format === 'duration' && Number.isFinite(n)) {
    const d = Math.floor(n / 86400), h = Math.floor((n % 86400) / 3600), m = Math.floor((n % 3600) / 60);
    return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
  }
  if (format === 'ago') {
    const t = typeof v === 'number' ? v : new Date(String(v)).getTime();
    if (!Number.isFinite(t)) return String(v);
    const minutes = Math.floor(Math.max(0, Date.now() - t) / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.floor(minutes / 60);
    return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
  }
  if (format === 'until') {   // a moment in the future: "4 minutes from now" ("Forever" when it is years away)
    const t = typeof v === 'number' ? v : new Date(String(v)).getTime();
    if (!Number.isFinite(t)) return String(v);
    const seconds = Math.round((t - Date.now()) / 1000);
    if (seconds > 10 * 365 * 86400) return 'Forever';
    if (seconds < 30) return 'now';
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${Math.max(1, minutes)} minute${minutes === 1 ? '' : 's'} from now`;
    const hours = Math.round(minutes / 60);
    return hours < 48 ? `${hours} hour${hours === 1 ? '' : 's'} from now` : `${Math.round(hours / 24)} days from now`;
  }
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

/** A value written for a tile or a gauge: the number and its unit, or the whole text when a `format` supplies it. */
export function formatStatValue(raw: string, format: ValueFormat | undefined, unit: string | undefined, decimals: number | undefined): { number: string; unit?: string } {
  if (format && format !== 'text') {
    if (format === 'percent') return { number: formatValueText(raw, '%', decimals) || '—', unit: '%' };
    const formatted = formatValue(raw, format) || '—';
    // A byte or rate value ends in its own unit ("18.4 MB/s"); keeping it apart lets a narrow tile put it on a second line.
    if (format === 'rate' || format === 'bytes') {
      const m = /^(.+?)\s([^\s]+)$/.exec(formatted);
      if (m) return { number: m[1], unit: m[2] };
    }
    return { number: formatted };
  }
  return { number: formatValueText(raw, unit, decimals) || '—', unit };
}

/** A value with its unit: "%" and "°C" sit tight, other units take a space. */
export function withUnit(value: string, unit: string | undefined): string {
  if (!unit || !value) return value;
  return unit.startsWith('%') || unit.startsWith('°') ? `${value}${unit}` : `${value} ${unit}`;
}
