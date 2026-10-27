'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

export interface ChartPoint { t: number; avg: number; min: number; max: number }
export interface ChartSeries { key: string; label: string; points: ChartPoint[]; color?: string }

// Categorical palette that reads in light and dark themes.
export const SERIES_COLORS = ['#3b82f6', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16'];

export function formatValue(v: number, unit: string): string {
  if (!Number.isFinite(v)) return '–';
  if (unit === 'B/s') {
    const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
    let i = 0;
    let x = v;
    while (x >= 1024 && i < units.length - 1) { x /= 1024; i++; }
    return `${x.toFixed(x < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
  }
  if (unit === 'MB') return v >= 1024 ? `${(v / 1024).toFixed(1)} GB` : `${Math.round(v)} MB`;
  const s = Math.abs(v) >= 100 ? Math.round(v).toString() : (Math.round(v * 10) / 10).toString();
  return unit ? `${s}${unit === '%' || unit === '°C' ? '' : ' '}${unit}` : s;
}

function formatTime(t: number, spanSec: number): string {
  const d = new Date(t * 1000);
  if (spanSec <= 2 * 86400) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

interface LineChartProps {
  series: ChartSeries[];
  unit: string;
  from: number;
  to: number;
  /** Fixed y-range max (e.g. 100 for percentages). */
  yMax?: number;
  height?: number;
  showBand?: boolean;
  /** Gap (seconds) above which the line is broken instead of interpolated. */
  gapSec?: number;
}

/**
 * Small dependency-free SVG time-series chart: avg line per series, optional
 * min/max band, hover crosshair with values. Fills its container's width.
 */
export function LineChart({ series, unit, from, to, yMax, height = 180, showBand = true, gapSec }: LineChartProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => setWidth(Math.max(120, Math.floor(entries[0].contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const pad = { l: 44, r: 8, t: 8, b: 20 };
  const w = width - pad.l - pad.r;
  const h = height - pad.t - pad.b;

  const { max, ticks } = useMemo(() => {
    let m = yMax ?? 0;
    if (yMax === undefined) {
      for (const s of series) for (const p of s.points) m = Math.max(m, showBand ? p.max : p.avg);
      m = m <= 0 ? 1 : m * 1.1;
    }
    const step = m / 4;
    return { max: m, ticks: [0, step, step * 2, step * 3, m] };
  }, [series, yMax, showBand]);

  const span = Math.max(1, to - from);
  const x = (t: number) => pad.l + ((t - from) / span) * w;
  const y = (v: number) => pad.t + h - (Math.max(0, v) / max) * h;
  const gap = gapSec ?? span / 50;

  const paths = series.map((s, i) => {
    const color = s.color || SERIES_COLORS[i % SERIES_COLORS.length];
    let line = '';
    let prevT: number | null = null;
    for (const p of s.points) {
      const cmd = prevT === null || p.t - prevT > gap ? 'M' : 'L';
      line += `${cmd}${x(p.t).toFixed(1)},${y(p.avg).toFixed(1)}`;
      prevT = p.t;
    }
    let band = '';
    if (showBand && s.points.length > 1) {
      band = s.points.map((p, j) => `${j ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.max).toFixed(1)}`).join('') +
        [...s.points].reverse().map(p => `L${x(p.t).toFixed(1)},${y(p.min).toFixed(1)}`).join('') + 'Z';
    }
    return { key: s.key, color, line, band };
  });

  const hoverT = hover === null ? null : from + ((hover - pad.l) / w) * span;
  const hoverValues = hoverT === null ? [] : series.map((s, i) => {
    let best: ChartPoint | null = null;
    for (const p of s.points) if (!best || Math.abs(p.t - hoverT) < Math.abs(best.t - hoverT)) best = p;
    return { label: s.label, color: s.color || SERIES_COLORS[i % SERIES_COLORS.length], p: best };
  }).filter(v => v.p && Math.abs(v.p.t - (hoverT as number)) <= gap);

  const empty = series.every(s => s.points.length === 0);

  return (
    <div ref={ref} className="relative w-full select-none" style={{ height }}>
      <svg width={width} height={height} role="img" aria-label="Metric history chart"
        onMouseMove={e => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const px = e.clientX - r.left;
          setHover(px >= pad.l && px <= pad.l + w ? px : null);
        }}
        onMouseLeave={() => setHover(null)}>
        {ticks.map(t => (
          <g key={t}>
            <line x1={pad.l} x2={pad.l + w} y1={y(t)} y2={y(t)} className="stroke-gray-200 dark:stroke-gray-700" strokeWidth={1} />
            <text x={pad.l - 4} y={y(t) + 3} textAnchor="end" className="fill-gray-500 dark:fill-gray-400" fontSize={10}>
              {formatValue(t, unit)}
            </text>
          </g>
        ))}
        {[0, 0.25, 0.5, 0.75, 1].map(f => (
          <text key={f} x={pad.l + f * w} y={height - 4} textAnchor={f === 0 ? 'start' : f === 1 ? 'end' : 'middle'}
            className="fill-gray-500 dark:fill-gray-400" fontSize={10}>
            {formatTime(from + f * span, span)}
          </text>
        ))}
        {paths.map(p => p.band && <path key={`${p.key}-band`} d={p.band} fill={p.color} opacity={0.12} />)}
        {paths.map(p => <path key={p.key} d={p.line} fill="none" stroke={p.color} strokeWidth={1.75} strokeLinejoin="round" />)}
        {hover !== null && <line x1={hover} x2={hover} y1={pad.t} y2={pad.t + h} className="stroke-gray-400" strokeDasharray="3 3" />}
      </svg>
      {empty && (
        <div className="absolute inset-0 flex items-center justify-center text-xs text-gray-500">No data for this range yet</div>
      )}
      {hoverT !== null && hoverValues.length > 0 && (
        <div className="pointer-events-none absolute top-1 z-10 rounded-md border border-gray-200 bg-white/95 px-2 py-1 text-xs shadow dark:border-gray-700 dark:bg-gray-900/95"
          style={{ left: Math.min(Math.max((hover ?? 0) + 8, 0), width - 170) }}>
          <div className="mb-0.5 text-gray-500">{new Date((hoverValues[0].p as ChartPoint).t * 1000).toLocaleString()}</div>
          {hoverValues.map(v => (
            <div key={v.label} className="flex items-center gap-1.5 whitespace-nowrap">
              <span className="inline-block size-2 rounded-full" style={{ background: v.color }} />
              <span className="max-w-[90px] truncate">{v.label}</span>
              <span className="ml-auto font-mono">{formatValue((v.p as ChartPoint).avg, unit)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
