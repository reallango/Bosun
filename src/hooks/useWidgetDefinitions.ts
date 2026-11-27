'use client';

import { useEffect, useMemo, useState } from 'react';
import type { WidgetDefinition } from '@/types/widget';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import { readJson } from '@/lib/api/readJson';

/** Widget definitions (display names and size hints) shared by the grid and the add-widget picker. */
let cache: { at: number; definitions: WidgetDefinition[] } | null = null;
let inflight: Promise<WidgetDefinition[]> | null = null;
const MAX_AGE_MS = 60_000;

function load(): Promise<WidgetDefinition[]> {
  if (cache && Date.now() - cache.at < MAX_AGE_MS) return Promise.resolve(cache.definitions);
  inflight ??= fetchWithAuth('/api/widget-definitions')
    .then(res => readJson<{ data?: { definitions?: WidgetDefinition[] } }>(res))
    .then(json => {
      const definitions = Array.isArray(json.data?.definitions) ? json.data.definitions : [];
      cache = { at: Date.now(), definitions };
      return definitions;
    })
    .catch(() => cache?.definitions ?? [])
    .finally(() => { inflight = null; });
  return inflight;
}

/** type -> definition, empty until loaded. */
export function useWidgetDefinitions(): Record<string, WidgetDefinition> {
  const [definitions, setDefinitions] = useState<WidgetDefinition[]>(cache?.definitions ?? []);
  useEffect(() => {
    let live = true;
    load().then(list => { if (live) setDefinitions(list); });
    return () => { live = false; };
  }, []);
  return useMemo(() => Object.fromEntries(definitions.map(d => [d.type, d])), [definitions]);
}
