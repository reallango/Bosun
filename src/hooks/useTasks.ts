'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import { readJson } from '@/lib/api/readJson';

export interface Task {
  id: string;
  widgetType: string;
  widgetName: string;
  actionId: string;
  actionLabel: string;
  serverId: string;
  serverName: string;
  widgetId: string | null;
  status: 'running' | 'success' | 'error' | 'cancelled' | 'lost';
  steps: string[];
  percent: number | null;
  message: string | null;
  startedAt: number;
  finishedAt: number | null;
  screenId: string | null;
  cancelRequested: boolean;
  /** Who started it (a person's name or "<key> (API key)"); null when Bosun did. */
  startedBy: string | null;
  /** Hidden from this person's bell; the Activity page still lists it. */
  dismissed: boolean;
}

const SEEN_KEY = 'bosun.tasks.seen';

function readSeen(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || '[]') as string[]); } catch { return new Set(); }
}

/**
 * The tasks (jobs of package widgets: a stack deploy, an image pull) for the notification area. Polled every few seconds while one
 * runs or the list is open, and about every half minute otherwise. `unseen` counts finished tasks the person has not looked at yet
 * in this browser.
 */
export function useTasks(open: boolean) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [seen, setSeen] = useState<Set<string>>(() => new Set());
  const openRef = useRef(open);
  openRef.current = open;
  const busyRef = useRef(false);
  busyRef.current = tasks.some(t => t.status === 'running');

  const load = useCallback(async () => {
    try {
      const res = await fetchWithAuth('/api/widget-jobs');
      if (!res.ok) return;
      const json = await readJson<{ data?: { tasks: Task[] } }>(res);
      if (json.data) setTasks(json.data.tasks);
    } catch { /* the next poll tries again */ }
  }, []);

  useEffect(() => { setSeen(readSeen()); }, []);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const loop = async () => {
      await load();
      if (!live) return;
      timer = setTimeout(loop, openRef.current || busyRef.current ? 4000 : 30000);
    };
    void loop();
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [load]);

  const markSeen = useCallback((ids: string[]) => {
    setSeen(prev => {
      const next = new Set(prev);
      ids.forEach(i => next.add(i));
      try { localStorage.setItem(SEEN_KEY, JSON.stringify(Array.from(next).slice(-100))); } catch { /* no storage: the badge comes back on reload */ }
      return next;
    });
  }, []);

  const setDismissed = useCallback(async (id: string, dismissed: boolean) => {
    setTasks(prev => prev.map(t => (t.id === id ? { ...t, dismissed } : t)));
    try {
      const res = await fetchWithAuth(`/api/widget-jobs/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dismissed }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      console.error('Failed to save task dismissal:', err);
      await load();
    }
  }, [load]);

  const dismissTask = useCallback((id: string) => setDismissed(id, true), [setDismissed]);
  const restoreTask = useCallback((id: string) => {
    // Restoring also makes it new again, so it is visible in the bell even when it is older than a day.
    setSeen(prev => {
      const next = new Set(prev);
      next.delete(id);
      try { localStorage.setItem(SEEN_KEY, JSON.stringify(Array.from(next).slice(-100))); } catch { /* no storage */ }
      return next;
    });
    return setDismissed(id, false);
  }, [setDismissed]);

  const running = tasks.filter(t => t.status === 'running').length;
  const unseen = tasks.filter(t => t.status !== 'running' && !t.dismissed && !seen.has(t.id)).length;
  const failedUnseen = tasks.filter(t => (t.status === 'error' || t.status === 'lost') && !t.dismissed && !seen.has(t.id)).length;
  return { tasks, running, unseen, failedUnseen, seen, markSeen, dismissTask, restoreTask, reload: load };
}
