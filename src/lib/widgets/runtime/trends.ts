/**
 * Sparkline trends: a small line of one metric's recent history under a stat tile or a field. A spec names the metric
 * and the window; the browser asks the metrics history API once for all the trends of a widget. Pure (no I/O), so the
 * shaping of the points and the SVG path can be tested.
 */
import { fail, isObj, type Validated } from './spec-util';

export const TREND_WINDOWS = ['1h', '6h', '24h'] as const;
export type TrendWindow = (typeof TREND_WINDOWS)[number];

/** The name pattern the metrics API accepts. */
export const TREND_METRIC_RE = /^[a-z0-9_.]{1,64}$/;

export interface TrendSpec {
  metric: string;
  window: TrendWindow;
}

export const TREND_WINDOW_SEC: Record<TrendWindow, number> = { '1h': 3600, '6h': 6 * 3600, '24h': 24 * 3600 };

export function trendWindowSec(window: TrendWindow): number {
  return TREND_WINDOW_SEC[window];
}

/** Validate an optional `trend` object. */
export function validateTrend(raw: unknown, where: string): Validated<TrendSpec | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (!isObj(raw)) return fail(`${where}: "trend" must be an object like {"metric": "cpu.usage", "window": "1h"}`);
  if (typeof raw.metric !== 'string' || !TREND_METRIC_RE.test(raw.metric)) {
    return fail(`${where}: trend.metric must be a metric name such as "cpu.usage"`);
  }
  if (typeof raw.window !== 'string' || !(TREND_WINDOWS as readonly string[]).includes(raw.window)) {
    return fail(`${where}: trend.window must be one of ${TREND_WINDOWS.join(', ')}`);
  }
  return { ok: true, value: { metric: raw.metric, window: raw.window as TrendWindow } };
}

function isTrend(v: unknown): v is TrendSpec {
  return isObj(v) && typeof v.metric === 'string' && TREND_METRIC_RE.test(v.metric)
    && typeof v.window === 'string' && (TREND_WINDOWS as readonly string[]).includes(v.window);
}

/**
 * Every distinct trend in a spec part (a view, a screen or a list of blocks). Walking the object keeps this generic:
 * stat items, fields items and any future block that carries a `trend` are all found.
 */
export function collectTrends(value: unknown): TrendSpec[] {
  const out: TrendSpec[] = [];
  const seen = new Set<string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (!isObj(v)) return;
    if (isTrend(v.trend)) {
      const key = `${v.trend.metric}|${v.trend.window}`;
      if (!seen.has(key)) { seen.add(key); out.push({ metric: v.trend.metric, window: v.trend.window }); }
    }
    for (const child of Object.values(v)) walk(child);
  };
  walk(value);
  return out;
}

/**
 * The one metrics request that serves every trend of a widget: the widest window any trend asks for, and each metric
 * once. The renderer then slices the points to each trend's own window. Null when there is nothing to ask for.
 */
export function trendRequest(trends: readonly TrendSpec[]): { metrics: string[]; range: TrendWindow } | null {
  if (!trends.length) return null;
  const metrics = Array.from(new Set(trends.map(t => t.metric))).slice(0, 12);
  const range = trends.reduce<TrendWindow>(
    (widest, t) => (TREND_WINDOWS.indexOf(t.window) > TREND_WINDOWS.indexOf(widest) ? t.window : widest),
    TREND_WINDOWS[0],
  );
  return { metrics, range };
}

export interface SparkPoint { t: number; v: number }

/** The points of a series inside one trend's window, oldest first. Unknown or non-numeric points are left out. */
export function shapeSparkline(
  points: readonly { t: number; avg: number }[],
  windowSec: number,
  now: number,
): SparkPoint[] {
  const from = now - windowSec;
  return points
    .filter(p => Number.isFinite(p.t) && Number.isFinite(p.avg) && p.t >= from && p.t <= now + 300)
    .map(p => ({ t: p.t, v: p.avg }))
    .sort((a, b) => a.t - b.t);
}

/** An SVG path for a sparkline, stretched into `width` x `height` with a small padding. Empty when there are no points. */
export function sparklinePath(points: readonly SparkPoint[], width = 100, height = 30, pad = 2): string {
  if (!points.length) return '';
  const ts = points.map(p => p.t);
  const vs = points.map(p => p.v);
  const t0 = Math.min(...ts);
  const t1 = Math.max(...ts);
  const v0 = Math.min(...vs);
  const v1 = Math.max(...vs);
  const innerW = Math.max(0, width - pad * 2);
  const innerH = Math.max(0, height - pad * 2);
  const x = (t: number) => (t1 === t0 ? pad + innerW / 2 : pad + ((t - t0) / (t1 - t0)) * innerW);
  const y = (v: number) => (v1 === v0 ? height / 2 : pad + (1 - (v - v0) / (v1 - v0)) * innerH);
  const round = (n: number) => Math.round(n * 100) / 100;
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${round(x(p.t))},${round(y(p.v))}`).join(' ');
}
