'use client';

import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import { readJson } from '@/lib/api/readJson';
import { collectTrends, trendRequest, type TrendSpec } from '@/lib/widgets/runtime/trends';

/** The history a widget's sparklines draw: one series per metric and the moment the request was answered. */
export interface TrendData {
  series: Record<string, { t: number; avg: number }[]>;
  to: number;
}

const TrendContext = createContext<TrendData | null>(null);

/** The history of the trends around this component, or null when there is none (a missing history draws nothing). */
export const useTrendData = () => useContext(TrendContext);

/** A widget asks once for all its trends, and shares the answer for a moment with any other widget of the same server. */
const TTL_MS = 20_000;
const cache = new Map<string, { at: number; value: TrendData }>();

interface MetricsAnswer {
  data?: { to?: number; series?: { metric: string; points?: { t: number; avg: number }[] }[] };
  error?: { message?: string };
}

/**
 * Fetches the metric history the trends of `source` need. `refreshKey` is the widget's data: the lines refresh with
 * it, but a fresh answer from the short cache is reused. There is no polling of its own.
 */
export function TrendProvider({ serverId, source, refreshKey, children }: {
  serverId: string;
  source: unknown;
  refreshKey?: unknown;
  children: React.ReactNode;
}) {
  const trends = useMemo<TrendSpec[]>(() => collectTrends(source), [source]);
  const trendKey = useMemo(() => JSON.stringify(trends), [trends]);
  const [data, setData] = useState<TrendData | null>(null);

  useEffect(() => {
    if (!trendKey) { setData(null); return; }
    const request = trendRequest(JSON.parse(trendKey) as TrendSpec[]);
    if (!request) { setData(null); return; }
    const key = `${serverId}|${request.metrics.join(',')}|${request.range}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) { setData(hit.value); return; }
    let live = true;
    (async () => {
      try {
        const res = await fetchWithAuth(`/api/metrics?serverId=${encodeURIComponent(serverId)}&metrics=${encodeURIComponent(request.metrics.join(','))}&range=${request.range}`);
        const json = await readJson<MetricsAnswer>(res);
        if (!res.ok || !json.data) return;
        const series: TrendData['series'] = {};
        for (const s of json.data.series ?? []) {
          series[s.metric] = (s.points ?? []).filter(p => Number.isFinite(p.t) && Number.isFinite(p.avg)).map(p => ({ t: p.t, avg: p.avg }));
        }
        const value: TrendData = { series, to: Number(json.data.to) || Math.floor(Date.now() / 1000) };
        cache.set(key, { at: Date.now(), value });
        if (live) setData(value);
      } catch {
        // The history is an extra: a widget without it still shows its numbers.
      }
    })();
    return () => { live = false; };
  }, [serverId, trendKey, refreshKey]);

  return <TrendContext.Provider value={data}>{children}</TrendContext.Provider>;
}
