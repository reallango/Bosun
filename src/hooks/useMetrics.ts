'use client';

import { useCallback, useEffect, useState } from 'react';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';

export interface MetricPoint { t: number; avg: number; min: number; max: number }
export interface MetricSeries { metric: string; label: string; unit: string; points: MetricPoint[] }
export interface MetricsResult {
  serverId: string;
  range: string;
  from: number;
  to: number;
  source: string;
  step: number;
  series: MetricSeries[];
}
export interface MetricInfo { metric: string; label: string; unit: string }

export const RANGE_OPTIONS = ['1h', '6h', '24h', '7d', '30d', '1y'] as const;

/** Refresh cadence per range: short ranges update often, long ones rarely. */
function refreshMs(range: string): number {
  return range === '15m' || range === '1h' ? 15_000 : range === '6h' || range === '24h' ? 60_000 : 300_000;
}

export function useMetricSeries(serverId: string | null, metrics: string[], range: string) {
  const [data, setData] = useState<MetricsResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const key = metrics.join(',');

  const load = useCallback(async () => {
    if (!serverId || !key) { setLoading(false); return; }
    try {
      const res = await fetchWithAuth(`/api/metrics?serverId=${encodeURIComponent(serverId)}&metrics=${encodeURIComponent(key)}&range=${range}`);
      const json = await res.json();
      if (!res.ok || json.error) throw new Error(json.error?.message || `HTTP ${res.status}`);
      setData(json.data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [serverId, key, range]);

  useEffect(() => {
    setLoading(true);
    load();
    const t = setInterval(() => { if (!document.hidden) load(); }, refreshMs(range));
    return () => clearInterval(t);
  }, [load, range]);

  return { data, error, loading, reload: load };
}

export function useMetricCatalog(serverId: string | null) {
  const [metrics, setMetrics] = useState<MetricInfo[]>([]);
  useEffect(() => {
    if (!serverId) return;
    let ignore = false;
    fetchWithAuth(`/api/metrics?serverId=${encodeURIComponent(serverId)}`)
      .then(r => r.json())
      .then(j => { if (!ignore) setMetrics(j.data?.metrics || []); })
      .catch(() => undefined);
    return () => { ignore = true; };
  }, [serverId]);
  return metrics;
}
