'use client';

import { useEffect, useState } from 'react';
import { LineChart, formatValue, SERIES_COLORS } from '@/components/charts/LineChart';
import { useMetricSeries, useMetricCatalog, RANGE_OPTIONS } from '@/hooks/useMetrics';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';

interface Props {
  widgetId: string;
  serverId: string;
  /** The metrics shown until a person picks others (a package widget's chart view names them). */
  defaultMetrics?: string[];
}

interface ChartConfig {
  metrics?: string[];
  range?: string;
}

const DEFAULT_METRICS = ['cpu.usage', 'mem.used_pct'];

/** Charts the history of one or more metrics of the widget's server. */
export function MetricsChartWidget({ widgetId, serverId, defaultMetrics }: Props) {
  const [config, setConfig] = useState<ChartConfig | null>(null);
  const [picking, setPicking] = useState(false);
  const catalog = useMetricCatalog(picking ? serverId : null);

  useEffect(() => {
    let ignore = false;
    fetchWithAuth(`/api/widgets/${widgetId}/settings`)
      .then(r => r.json())
      .then(j => {
        if (ignore) return;
        const raw = j.data?.config;
        let cfg: ChartConfig = {};
        try { cfg = typeof raw === 'string' ? JSON.parse(raw) : raw || {}; } catch { /* default */ }
        setConfig(cfg);
      })
      .catch(() => setConfig({}));
    return () => { ignore = true; };
  }, [widgetId]);

  const fallback = defaultMetrics?.length ? defaultMetrics : DEFAULT_METRICS;
  const metrics = config?.metrics?.length ? config.metrics : fallback;
  const range = config?.range || '24h';
  const { data, error, loading } = useMetricSeries(config ? serverId : null, metrics, range);

  const save = (next: ChartConfig) => {
    setConfig(next);
    fetchWithAuth(`/api/widgets/${widgetId}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: next }),
    }).catch(() => undefined);
  };

  // Series of different units cannot share an axis; chart them per unit.
  const groups = new Map<string, NonNullable<typeof data>['series']>();
  for (const s of data?.series || []) groups.set(s.unit, [...(groups.get(s.unit) || []), s]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5 text-sm">
      <div className="flex flex-wrap items-center gap-1">
        {RANGE_OPTIONS.map(r => (
          <button key={r} onClick={() => save({ ...config, metrics, range: r })}
            className={`rounded px-1.5 py-0.5 text-xs ${r === range ? 'bg-blue-600 text-white' : 'text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800'}`}>
            {r}
          </button>
        ))}
        <button onClick={() => setPicking(p => !p)} className="ml-auto rounded px-1.5 py-0.5 text-xs text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800" aria-expanded={picking}>
          Metrics…
        </button>
      </div>
      {picking && (
        <div className="flex max-h-28 flex-wrap gap-1 overflow-auto rounded border border-gray-200 p-1.5 dark:border-gray-700">
          {catalog.length === 0 && <span className="text-xs text-gray-500">No history recorded yet</span>}
          {catalog.map(m => {
            const on = metrics.includes(m.metric);
            return (
              <button key={m.metric}
                onClick={() => {
                  const next = on ? metrics.filter(x => x !== m.metric) : [...metrics, m.metric].slice(-6);
                  save({ ...config, range, metrics: next.length ? next : fallback });
                }}
                className={`rounded-full border px-2 py-0.5 text-[11px] ${on ? 'border-blue-600 bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300' : 'border-gray-300 text-gray-600 dark:border-gray-600 dark:text-gray-300'}`}>
                {m.label}
              </button>
            );
          })}
        </div>
      )}
      {error && <p className="text-xs text-red-600">{error}</p>}
      {loading && !data && <p className="text-xs text-gray-500">Loading history…</p>}
      <div className="min-h-0 flex-1 space-y-2 overflow-auto">
        {data && Array.from(groups.entries()).map(([unit, series]) => {
          const latest = series.map((s, i) => ({ s, i, last: s.points[s.points.length - 1] }));
          return (
            <div key={unit || 'none'}>
              <div className="mb-0.5 flex flex-wrap gap-x-3 text-xs">
                {latest.map(({ s, last }) => {
                  const idx = data.series.indexOf(s);
                  return (
                    <span key={s.metric} className="flex items-center gap-1">
                      <span className="inline-block size-2 rounded-full" style={{ background: SERIES_COLORS[idx % SERIES_COLORS.length] }} />
                      <span className="text-gray-500">{s.label}</span>
                      <span className="font-mono">{last ? formatValue(last.avg, unit) : '–'}</span>
                    </span>
                  );
                })}
              </div>
              <LineChart
                series={series.map(s => ({ key: s.metric, label: s.label, points: s.points, color: SERIES_COLORS[data.series.indexOf(s) % SERIES_COLORS.length] }))}
                unit={unit}
                from={data.from}
                to={data.to}
                yMax={unit === '%' ? 100 : undefined}
                height={groups.size > 1 ? 120 : 170}
                gapSec={Math.max(data.step * 3, 120)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
