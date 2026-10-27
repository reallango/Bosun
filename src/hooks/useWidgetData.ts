import { useState, useEffect, useCallback, useRef } from 'react';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import { useWidgetFrame } from '@/components/dashboard/widget-context';

/**
 * Polls /api/widgets/:id/data. The enclosing WidgetFrame's "Refresh" action
 * triggers a forced (cache-bypassing) fetch through the same code path.
 */
export function useWidgetData(widgetId: string, refreshInterval: number = 15) {
  const [data, setData] = useState<unknown>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const frame = useWidgetFrame();

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const fetchData = useCallback(async (force = false) => {
    try {
      const url = force ? `/api/widgets/${widgetId}/data?force=true` : `/api/widgets/${widgetId}/data`;
      const res = await fetchWithAuth(url);
      const json = await res.json();
      if (!mounted.current) return;
      if (json.error) {
        setError(json.error.message);
      } else {
        setData(json.data);
        setError(null);
      }
    } catch (err) {
      if (mounted.current) setError(String(err));
    } finally {
      if (mounted.current) setIsLoading(false);
    }
  }, [widgetId]);

  useEffect(() => {
    fetchData();

    const interval = setInterval(() => {
      if (typeof document === 'undefined' || !document.hidden) fetchData();
    }, refreshInterval * 1000);
    return () => clearInterval(interval);
  }, [fetchData, refreshInterval]);

  useEffect(() => {
    const handleVisibility = () => {
      if (!document.hidden) fetchData();
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [fetchData]);

  const refresh = useCallback(() => fetchData(true), [fetchData]);

  // Let the frame's Refresh menu item drive a forced fetch for this widget.
  useEffect(() => {
    if (!frame) return;
    return frame.registerRefresh(refresh);
  }, [frame, refresh]);

  return { data, isLoading, error, refresh };
}
