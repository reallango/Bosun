'use client';

import { useEffect, useState } from 'react';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import { readJson } from '@/lib/api/readJson';

/** Display names of the widget types (a package widget's name lives in its package, not in the code). */
let cache: { at: number; names: Record<string, string> } | null = null;
let inflight: Promise<Record<string, string>> | null = null;
const MAX_AGE_MS = 60_000;

function load(): Promise<Record<string, string>> {
  if (cache && Date.now() - cache.at < MAX_AGE_MS) return Promise.resolve(cache.names);
  inflight ??= fetchWithAuth('/api/widget-definitions')
    .then(res => readJson<{ data?: { definitions?: { type: string; displayName: string }[] } }>(res))
    .then(json => {
      const names = Object.fromEntries((json.data?.definitions ?? []).map(d => [d.type, d.displayName]));
      cache = { at: Date.now(), names };
      return names;
    })
    .catch(() => cache?.names ?? {})
    .finally(() => { inflight = null; });
  return inflight;
}

/** type -> display name, empty until loaded; callers fall back to a readable form of the type. */
export function useWidgetNames(): Record<string, string> {
  const [names, setNames] = useState<Record<string, string>>(cache?.names ?? {});
  useEffect(() => {
    let live = true;
    load().then(n => { if (live) setNames(n); });
    return () => { live = false; };
  }, []);
  return names;
}
