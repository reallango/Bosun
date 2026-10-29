/**
 * Maps poller snapshots (host_snapshots sections) to the JSON each widget
 * renders. Widgets never trigger SSH for monitoring data; they read what the
 * poller last stored.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Sections = Record<string, { data: any; collectedAt: number }>;

/** Snapshot sections each widget type needs. */
export const WIDGET_SECTIONS: Record<string, string[]> = {
  ollama_status: ['ollama'],
  os_update_check: ['updates'],
};

export interface ServerRow {
  id: string;
  name: string;
  hostname: string;
  platform?: string | null;
  os_type?: string | null;
  os_version?: string | null;
  is_online?: number | boolean | null;
  last_seen?: string | null;
  last_error?: string | null;
  poll_interval_sec?: number | null;
}

function formatUptime(sec: number | null | undefined): string {
  if (!sec && sec !== 0) return '';
  return `${Math.floor(sec / 86400)}d ${Math.floor((sec % 86400) / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

/**
 * Returns `undefined` when the widget type is unknown, `null` when the data has
 * not been collected yet.
 */
export function widgetDataFromSnapshots(type: string, s: Sections, server: ServerRow, cfg: Record<string, any> = {}): any {
  const d = (name: string) => s[name]?.data;
  switch (type) {
    case 'ollama_status':
      return d('ollama') ?? null;
    case 'os_update_check':
      return d('updates') ?? null;
    default:
      return undefined;
  }
}

/** Oldest collected_at among the sections a widget uses (ms epoch). */
export function collectedAtFor(type: string, s: Sections): number | null {
  const times = (WIDGET_SECTIONS[type] || []).map(n => s[n]?.collectedAt).filter((t): t is number => typeof t === 'number');
  return times.length ? Math.min(...times) : null;
}
