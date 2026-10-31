import { useState, useEffect, useCallback, useRef } from 'react';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import { readJson } from '@/lib/api/readJson';
import type { JobState } from '@/lib/widgets/runtime/layout';

const FAST_MS = 2000;
const SLOW_MS = 20000;

/**
 * The newest job of a widget type on a server (GET /api/servers/:id/widget-jobs/:type): polled every two seconds while
 * one runs, rarely otherwise. `enabled` is false for widgets that have no job actions, so they never ask.
 * `refresh` checks at once (after starting a job); `cancel` asks the running job to stop.
 */
export function useWidgetJob(serverId: string, widgetType: string, enabled: boolean) {
  const [job, setJob] = useState<JobState | null>(null);
  const mounted = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; if (timer.current) clearTimeout(timer.current); }; }, []);

  const load = useCallback(async (): Promise<JobState | null> => {
    try {
      const res = await fetchWithAuth(`/api/servers/${serverId}/widget-jobs/${encodeURIComponent(widgetType)}`);
      const json = await readJson<{ data?: { job: JobState | null } }>(res);
      const next = json.data?.job ?? null;
      if (mounted.current) setJob(next);
      return next;
    } catch {
      return null;
    }
  }, [serverId, widgetType]);

  const loop = useCallback(async () => {
    const j = await load();
    if (!mounted.current) return;
    timer.current = setTimeout(loop, j && j.status === 'running' ? FAST_MS : SLOW_MS);
  }, [load]);

  useEffect(() => {
    if (!enabled) return;
    void loop();
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [enabled, loop]);

  /** Check now and keep following quickly (a job was just started). */
  const refresh = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    await loop();
  }, [loop]);

  const cancel = useCallback(async () => {
    if (!job) return;
    await fetchWithAuth(`/api/servers/${serverId}/widget-jobs/${encodeURIComponent(widgetType)}/${job.id}/cancel`, { method: 'POST' });
    await refresh();
  }, [job, serverId, widgetType, refresh]);

  return { job, refresh, cancel };
}
