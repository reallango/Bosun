import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';
import { WidgetDefinition } from '@/types/widget';
import { widgetRegistry, getWidgetDefinition as getBuiltinDefinition } from './registry';

/**
 * Resolve the widget definitions available to a server.
 *
 * Built-in definitions are compiled into `registry.ts`; custom definitions are
 * rows in `custom_widgets`. Both are merged here so every consumer (the Add
 * Widget modal, the create route's default sizing, the data route's dispatch)
 * sees one list and one lookup.
 *
 * `server.platform` filters out definitions that do not support that platform,
 * which is how a "Linux only" custom widget disappears from a Windows server's
 * Add Widget list.
 */

export interface CustomWidgetRow {
  id: string;
  type: string;
  display_name: string;
  description: string | null;
  icon: string | null;
  category: string | null;
  default_size: string | null;
  min_size: string | null;
  refresh_interval: number | null;
  use_database: number;
  supports_linux: number;
  supports_windows: number;
  default_poll_interval: number | null;
  default_ttl: number | null;
  storage_mode: string | null;
  config_schema: string | null;
  enabled: number;
  builtin: number;
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (raw == null) return fallback;
  if (typeof raw === 'object') return raw as T;
  try {
    return JSON.parse(String(raw)) as T;
  } catch {
    return fallback;
  }
}

/** Convert a `custom_widgets` row into the shared WidgetDefinition shape. */
export function customRowToDefinition(row: CustomWidgetRow): WidgetDefinition {
  const defaultSize = parseJson(row.default_size, { w: 8, h: 6 });
  const minSize = parseJson(row.min_size, { w: 4, h: 4 });
  return {
    type: row.type,
    displayName: row.display_name,
    description: row.description || '',
    icon: row.icon || 'puzzle',
    category: (row.category as WidgetDefinition['category']) || 'custom',
    defaultSize,
    minSize,
    refreshInterval: row.refresh_interval ?? 30,
    backgroundPollable: !!row.use_database,
    defaultPollInterval: row.default_poll_interval ?? 30,
    defaultTTL: row.default_ttl ?? 1800,
    storageMode: (row.storage_mode as WidgetDefinition['storageMode']) || 'latest_ttl',
    isCustom: true,
    useDatabase: !!row.use_database,
    supportsLinux: !!row.supports_linux,
    supportsWindows: !!row.supports_windows,
    configSchema: parseJson(row.config_schema, []),
  };
}

/** Does this definition run on the given platform? Defaults to yes. */
export function supportsPlatform(def: WidgetDefinition, platform: string | null | undefined): boolean {
  const win = platform === 'windows';
  if (win) return def.supportsWindows !== false;
  return def.supportsLinux !== false;
}

export async function getCustomWidgetDefinitions(): Promise<WidgetDefinition[]> {
  try {
    const res = await rqlite.query('SELECT * FROM custom_widgets WHERE enabled = 1 ORDER BY display_name');
    return rowsToObjects(res).map(r => customRowToDefinition(r as unknown as CustomWidgetRow));
  } catch {
    // Before migration 008 the table does not exist; treat that as "no custom widgets".
    return [];
  }
}

/**
 * All widget definitions (built-ins first, then custom) for a server platform.
 * When `platform` is omitted every definition is returned.
 */
export async function getWidgetDefinitions(platform?: string | null): Promise<WidgetDefinition[]> {
  const all = [...Object.values(widgetRegistry), ...(await getCustomWidgetDefinitions())];
  if (platform === undefined || platform === null) return all;
  return all.filter(d => supportsPlatform(d, platform));
}

/** Look up one definition (built-in or custom), regardless of platform. */
export async function resolveWidgetDefinition(type: string): Promise<WidgetDefinition | undefined> {
  const builtin = getBuiltinDefinition(type);
  if (builtin) return builtin;
  try {
    const res = await rqlite.query('SELECT * FROM custom_widgets WHERE type = ?', [type]);
    const rows = rowsToObjects(res);
    if (!rows.length) return undefined;
    return customRowToDefinition(rows[0] as unknown as CustomWidgetRow);
  } catch {
    return undefined;
  }
}
