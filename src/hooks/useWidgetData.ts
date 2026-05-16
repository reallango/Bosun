import { useState, useEffect, useCallback } from 'react';

export function useWidgetData(widgetId: string, refreshInterval: number = 15) {
  const [data, setData] = useState<unknown>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async (force = false) => {
    try {
      const url = force ? `/api/widgets/${widgetId}/data?force=true` : `/api/widgets/${widgetId}/data`;
      const res = await fetch(url);
      const json = await res.json();
      if (json.error) {
        setError(json.error.message);
      } else {
        setData(json.data);
        setError(null);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setIsLoading(false);
    }
  }, [widgetId]);

  useEffect(() => {
    fetchData();

    const interval = setInterval(() => fetchData(), refreshInterval * 1000);
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

  return { data, isLoading, error, refresh };
}