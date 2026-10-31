'use client';

import { useEffect, useMemo, useState } from 'react';
import { LineChart, formatValue, SERIES_COLORS } from '@/components/charts/LineChart';
import { RANGE_OPTIONS, MetricsResult } from '@/hooks/useMetrics';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import Header from '@/components/layout/Header';

interface ServerItem {
  id: string;
  name: string;
  host: string;
  platform: string;
  is_online: boolean;
  last_seen: string | null;
  last_error: string | null;
  poll_interval_sec: number;
  capabilities: { gpus?: number; docker?: boolean };
}

// Metrics every host reports, plus the first GPU when any host has one.
const BASE_METRICS = [
  { metric: 'cpu.usage', label: 'CPU usage', unit: '%' },
  { metric: 'mem.used_pct', label: 'Memory used', unit: '%' },
  { metric: 'net.rx_bps', label: 'Network in', unit: 'B/s' },
  { metric: 'net.tx_bps', label: 'Network out', unit: 'B/s' },
  { metric: 'disk.max_used_pct', label: 'Fullest disk', unit: '%' },
  { metric: 'cpu.load1', label: 'Load (1m)', unit: '' },
  { metric: 'cpu.temp', label: 'CPU temperature', unit: '°C' },
];
const GPU_METRICS = [
  { metric: 'gpu0.util', label: 'GPU 0 utilization', unit: '%' },
  { metric: 'gpu0.vram_mb', label: 'GPU 0 VRAM used', unit: 'MB' },
  { metric: 'gpu0.temp', label: 'GPU 0 temperature', unit: '°C' },
  { metric: 'gpu0.power_w', label: 'GPU 0 power', unit: 'W' },
];

/**
 * Fleet statistics: compare one metric across every selected server over a
 * time range. History comes from the poller's samples and rollups.
 */
export default function StatsPage() {
  const [servers, setServers] = useState<ServerItem[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [range, setRange] = useState<string>('24h');
  const [metric, setMetric] = useState('cpu.usage');
  const [results, setResults] = useState<Record<string, MetricsResult>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchWithAuth('/api/servers')
      .then(r => r.json())
      .then(j => {
        const list: ServerItem[] = j.data?.servers || [];
        setServers(list);
        setSelected(list.map(s => s.id));
      })
      .catch(err => setError(String(err)));
  }, []);

  const hasGpu = servers.some(s => (s.capabilities?.gpus || 0) > 0);
  const metricOptions = hasGpu ? [...BASE_METRICS, ...GPU_METRICS] : BASE_METRICS;
  const info = metricOptions.find(m => m.metric === metric) || BASE_METRICS[0];

  useEffect(() => {
    if (!selected.length) { setResults({}); return; }
    let ignore = false;
    const load = async () => {
      setLoading(true);
      try {
        const entries = await Promise.all(selected.map(async id => {
          const r = await fetchWithAuth(`/api/metrics?serverId=${encodeURIComponent(id)}&metrics=${metric}&range=${range}`);
          const j = await r.json();
          return [id, j.data as MetricsResult] as const;
        }));
        if (!ignore) { setResults(Object.fromEntries(entries.filter(([, d]) => d))); setError(null); }
      } catch (err) {
        if (!ignore) setError(String(err));
      } finally {
        if (!ignore) setLoading(false);
      }
    };
    load();
    const t = setInterval(() => { if (!document.hidden) load(); }, range === '1h' ? 15_000 : 60_000);
    return () => { ignore = true; clearInterval(t); };
  }, [selected, metric, range]);

  const chart = useMemo(() => {
    const first = Object.values(results)[0];
    const series = servers.filter(s => selected.includes(s.id)).map(s => ({
      key: s.id,
      label: s.name,
      color: SERIES_COLORS[servers.indexOf(s) % SERIES_COLORS.length],
      points: results[s.id]?.series?.[0]?.points || [],
    }));
    return { series, from: first?.from ?? Math.floor(Date.now() / 1000) - 86400, to: first?.to ?? Math.floor(Date.now() / 1000), step: first?.step ?? 60 };
  }, [results, servers, selected]);

  const toggle = (id: string) => setSelected(sel => (sel.includes(id) ? sel.filter(x => x !== id) : [...sel, id]));

  return (
    <>
    <Header title="Statistics" />
    <div className="page max-w-[1800px] space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>

          <p className="text-sm text-gray-500">Compare history across hosts. Raw samples are kept for 48 h, 5-minute averages for 30 days, hourly averages for about a year.</p>
        </div>
        <div className="flex flex-wrap gap-1" role="group" aria-label="Time range">
          {RANGE_OPTIONS.map(r => (
            <button key={r} onClick={() => setRange(r)}
              className={`rounded-md px-2.5 py-1 text-sm ${r === range ? 'bg-blue-600 text-white' : 'border border-gray-200 text-gray-600 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800'}`}>
              {r}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
        <aside className="space-y-4 rounded-xl border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900">
          <div>
            <h2 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500">Metric</h2>
            <select value={metric} onChange={e => setMetric(e.target.value)} aria-label="Metric"
              className="w-full rounded-md border border-gray-200 bg-transparent px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900">
              {metricOptions.map(m => <option key={m.metric} value={m.metric}>{m.label}</option>)}
            </select>
          </div>
          <div>
            <h2 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500">Hosts</h2>
            <ul className="grid grid-cols-2 gap-1 sm:grid-cols-3 lg:grid-cols-1">
              {servers.map((s, i) => (
                <li key={s.id}>
                  <label className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-gray-50 dark:hover:bg-gray-800">
                    <input type="checkbox" checked={selected.includes(s.id)} onChange={() => toggle(s.id)} />
                    <span className="inline-block size-2.5 shrink-0 rounded-full" style={{ background: SERIES_COLORS[i % SERIES_COLORS.length] }} />
                    <span className="truncate">{s.name}</span>
                    <span className={`ml-auto size-1.5 shrink-0 rounded-full ${s.is_online ? 'bg-green-500' : 'bg-red-500'}`} title={s.is_online ? 'online' : (s.last_error || 'offline')} />
                  </label>
                </li>
              ))}
              {servers.length === 0 && <li className="text-sm text-gray-500">No servers yet</li>}
            </ul>
          </div>
        </aside>

        <section className="min-w-0 space-y-4">
          <div className="rounded-xl border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900">
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="font-medium">{info.label} <span className="text-sm font-normal text-gray-500">· last {range}</span></h2>
              <span className="text-xs text-gray-500">{loading ? 'Updating…' : chart.step ? `${chart.step >= 60 ? `${Math.round(chart.step / 60)} min` : `${chart.step} s`} resolution` : ''}</span>
            </div>
            {error && <p className="mb-2 text-sm text-red-600">{error}</p>}
            <LineChart series={chart.series} unit={info.unit} from={chart.from} to={chart.to}
              yMax={info.unit === '%' ? 100 : undefined} height={320} showBand={chart.series.length <= 2} gapSec={Math.max(chart.step * 3, 120)} />
          </div>

          <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
            <table className="w-full min-w-[480px] text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-gray-500">
                <tr className="border-b border-gray-200 dark:border-gray-700">
                  <th className="px-3 py-2 font-medium">Host</th>
                  <th className="px-3 py-2 text-right font-medium">Latest</th>
                  <th className="px-3 py-2 text-right font-medium">Average</th>
                  <th className="px-3 py-2 text-right font-medium">Peak</th>
                  <th className="px-3 py-2 text-right font-medium">Samples</th>
                </tr>
              </thead>
              <tbody>
                {chart.series.map(s => {
                  const pts = s.points;
                  const avg = pts.length ? pts.reduce((a, p) => a + p.avg, 0) / pts.length : NaN;
                  const peak = pts.length ? Math.max(...pts.map(p => p.max)) : NaN;
                  return (
                    <tr key={s.key} className="border-b border-gray-100 last:border-0 dark:border-gray-800">
                      <td className="px-3 py-2"><span className="mr-2 inline-block size-2 rounded-full" style={{ background: s.color }} />{s.label}</td>
                      <td className="px-3 py-2 text-right font-mono">{pts.length ? formatValue(pts[pts.length - 1].avg, info.unit) : '–'}</td>
                      <td className="px-3 py-2 text-right font-mono">{formatValue(avg, info.unit)}</td>
                      <td className="px-3 py-2 text-right font-mono">{formatValue(peak, info.unit)}</td>
                      <td className="px-3 py-2 text-right text-gray-500">{pts.length}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
    </>
  );
}
