import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';
import { WidgetDefinition, WidgetConfigField } from '@/types/widget';
import { widgetRegistry, getWidgetDefinition as getBuiltinDefinition } from './registry';

/**
 * Resolve the widget definitions available to a server (server-side only).
 *
 * Built-in definitions are compiled into `registry.ts`; custom definitions are
 * rows in `custom_widgets`. Both are merged here so every consumer (the Add
 * Widget picker, the create route's sizing and platform check, the settings
 * dialog's config fields) sees one list and one lookup.
 *
 * A package widget's data and screen are declared in its package (see lib/widgets/runtime); the database row
 * only describes it, so admins can retune it without a rebuild.
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
  supports_linux: number;
  supports_windows: number;
  config_schema: string | null;
  enabled: number;
  builtin: number;
  package_id?: string | null;
}

/**
 * Custom widget types that can be registered: they need a data source (a
 * snapshot section mapping) and a component, i.e. they are known to the code
 * but not compiled into the registry.
 */

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
  return {
    type: row.type,
    displayName: row.display_name,
    description: row.description || '',
    icon: row.icon || 'puzzle',
    category: (row.category as WidgetDefinition['category']) || 'custom',
    defaultSize: parseJson(row.default_size, { w: 8, h: 6 }),
    minSize: parseJson(row.min_size, { w: 4, h: 4 }),
    refreshInterval: row.refresh_interval ?? 30,
    backgroundPollable: true,
    isCustom: true,
    packageId: row.package_id ?? undefined,
    supportsLinux: !!row.supports_linux,
    supportsWindows: !!row.supports_windows,
    configSchema: parseJson<WidgetConfigField[]>(row.config_schema, []),
  };
}

/** Does this definition run on the given platform? Defaults to yes. */
export function supportsPlatform(def: WidgetDefinition, platform: string | null | undefined): boolean {
  return platform === 'windows' ? def.supportsWindows !== false : def.supportsLinux !== false;
}

export async function getCustomWidgetDefinitions(): Promise<WidgetDefinition[]> {
  try {
    const res = await rqlite.query('SELECT * FROM custom_widgets WHERE enabled = 1 ORDER BY display_name');
    return rowsToObjects(res).map(r => customRowToDefinition(r as unknown as CustomWidgetRow));
  } catch {
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

/** Look up one definition (built-in or custom, enabled or not), regardless of platform. */
export async function resolveWidgetDefinition(type: string): Promise<WidgetDefinition | undefined> {
  const builtin = getBuiltinDefinition(type);
  if (builtin) return builtin;
  try {
    const res = await rqlite.query('SELECT * FROM custom_widgets WHERE type = ?', [type]);
    const rows = rowsToObjects(res);
    return rows.length ? customRowToDefinition(rows[0] as unknown as CustomWidgetRow) : undefined;
  } catch {
    return undefined;
  }
}
