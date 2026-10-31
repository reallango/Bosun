import { rqlite } from '@/lib/db/rqlite-client';

/**
 * Metric history reads. The poller stores raw samples (short retention) and
 * 5-minute / 1-hour rollups (long retention). A query picks the coarsest
 * source that still gives enough points for the range, then buckets to at
 * most ~MAX_POINTS points.
 */

export const RANGES: Record<string, number> = {
  '15m': 15 * 60,
  '1h': 3600,
  '6h': 6 * 3600,
  '24h': 86400,
  '7d': 7 * 86400,
  '30d': 30 * 86400,
  '90d': 90 * 86400,
  '1y': 365 * 86400,
};

export const MAX_POINTS = 400;
export const METRIC_RE = /^[a-z0-9_.]{1,64}$/;

export interface SeriesPoint { t: number; avg: number; min: number; max: number }
export interface Series { metric: string; points: SeriesPoint[] }
export interface SeriesResult {
  serverId: string;
  range: string;
  from: number;
  to: number;
  source: 'raw' | 'rollup_5m' | 'rollup_1h';
  step: number;
  series: Series[];
}

/** Choose the data source and bucket size for a range (seconds). */
export function planQuery(rangeSec: number, rawRetentionSec: number): { source: SeriesResult['source']; step: number } {
  let source: SeriesResult['source'];
  if (rangeSec <= Math.min(24 * 3600, rawRetentionSec)) source = 'raw';
  else if (rangeSec <= 30 * 86400) source = 'rollup_5m';
  else source = 'rollup_1h';
  const minStep = source === 'raw' ? 1 : source === 'rollup_5m' ? 300 : 3600;
  const ideal = Math.ceil(rangeSec / MAX_POINTS);
  const step = Math.max(minStep, Math.ceil(ideal / minStep) * minStep);
  return { source, step };
}

export async function querySeries(serverId: string, metrics: string[], range: string, now = Math.floor(Date.now() / 1000)): Promise<SeriesResult> {
  const rangeSec = RANGES[range];
  if (!rangeSec) throw Object.assign(new Error(`Unknown range ${range}`), { status: 400 });
  const clean = metrics.filter(m => METRIC_RE.test(m)).slice(0, 12);
  if (!clean.length) throw Object.assign(new Error('No valid metrics requested'), { status: 400 });

  let rawRetentionSec = 48 * 3600;
  try {
    const r = await rqlite.query("SELECT value FROM app_config WHERE key = 'metrics.raw_retention_hours'");
    const h = Number(r.values?.[0]?.[0]);
    if (h > 0) rawRetentionSec = h * 3600;
  } catch { /* default */ }

  const { source, step } = planQuery(rangeSec, rawRetentionSec);
  const from = now - rangeSec;
  const ph = clean.map(() => '?').join(',');
  let sql: string;
  let params: unknown[];
  if (source === 'raw') {
    sql = `SELECT metric, (ts / ?) * ? AS b, AVG(value), MIN(value), MAX(value) FROM metric_samples
           WHERE server_id = ? AND metric IN (${ph}) AND ts >= ? GROUP BY metric, b ORDER BY metric, b`;
    params = [step, step, serverId, ...clean, from];
  } else {
    const res = source === 'rollup_5m' ? 300 : 3600;
    // Weighted average across rollup buckets merged into one step.
    sql = `SELECT metric, (bucket / ?) * ? AS b, SUM(avg * n) / SUM(n), MIN("min"), MAX("max") FROM metric_rollups
           WHERE server_id = ? AND resolution = ? AND metric IN (${ph}) AND bucket >= ? GROUP BY metric, b ORDER BY metric, b`;
    params = [step, step, serverId, res, ...clean, from];
  }
  const r = await rqlite.query(sql, params);
  const byMetric = new Map<string, SeriesPoint[]>(clean.map(m => [m, []]));
  for (const [metric, b, avg, min, max] of r.values) {
    byMetric.get(String(metric))?.push({ t: Number(b), avg: round(Number(avg)), min: round(Number(min)), max: round(Number(max)) });
  }
  return {
    serverId, range, from, to: now, source, step,
    series: clean.map(metric => ({ metric, points: byMetric.get(metric) || [] })),
  };
}

function round(v: number) {
  return Math.round(v * 100) / 100;
}

/** Metrics that have data for a server (from the 1h rollups, cheap). */
export async function listMetrics(serverId: string): Promise<string[]> {
  const r = await rqlite.query(
    'SELECT DISTINCT metric FROM metric_rollups WHERE server_id = ? AND resolution = 3600 ORDER BY metric', [serverId]);
  return r.values.map(v => String(v[0]));
}

/** Human labels/units for known metrics (prefix match for gpuN.*). */
export function describeMetric(metric: string): { label: string; unit: string } {
  const gpu = metric.match(/^gpu(\d+)\.(\w+)$/);
  if (gpu) {
    const kind: Record<string, [string, string]> = {
      util: ['utilization', '%'], vram_mb: ['VRAM used', 'MB'], temp: ['temperature', '°C'], power_w: ['power', 'W'],
    };
    const [l, u] = kind[gpu[2]] || [gpu[2], ''];
    return { label: `GPU ${gpu[1]} ${l}`, unit: u };
  }
  const known: Record<string, [string, string]> = {
    'cpu.usage': ['CPU usage', '%'], 'cpu.load1': ['Load (1m)', ''], 'cpu.temp': ['CPU temperature', '°C'],
    'mem.used_pct': ['Memory used', '%'], 'mem.used_mb': ['Memory used', 'MB'], 'swap.used_mb': ['Swap used', 'MB'],
    'net.rx_bps': ['Network in', 'B/s'], 'net.tx_bps': ['Network out', 'B/s'],
    'disk.root_used_pct': ['Root disk used', '%'], 'disk.max_used_pct': ['Fullest disk', '%'],
  };
  const [label, unit] = known[metric] || [metric, ''];
  return { label, unit };
}

/**
 * A package widget's label and unit for a metric the built-in list does not know (`defs` are rows of
 * metric_definitions; a `*` in a pattern matches anything). The built-in description wins when it knows the metric.
 */
export function describeFromDefinitions(
  defs: { pattern: string; label: string | null; unit: string | null }[],
  metric: string,
  builtin: { label: string; unit: string },
): { label: string; unit: string } {
  if (builtin.label !== metric) return builtin;
  for (const d of defs) {
    if (wildcardMatch(d.pattern, metric)) return { label: d.label || metric, unit: d.unit || builtin.unit };
  }
  return builtin;
}

/** Does `text` match `pattern`, where `*` stands for any run of characters? */
export function wildcardMatch(pattern: string, text: string): boolean {
  const parts = pattern.split('*');
  if (parts.length === 1) return pattern === text;
  if (!text.startsWith(parts[0])) return false;
  let pos = parts[0].length;
  for (let i = 1; i < parts.length - 1; i++) {
    const at = text.indexOf(parts[i], pos);
    if (at < 0) return false;
    pos = at + parts[i].length;
  }
  const last = parts[parts.length - 1];
  return text.length - pos >= last.length && text.endsWith(last);
}
