/**
 * Validation for custom widget definitions written through the API. Returns
 * column values ready for SQL (JSON columns serialised, booleans as 0/1), or
 * an error message.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

const FIELD_TYPES = ['string', 'number', 'boolean', 'select'];
const CATEGORIES = ['system', 'docker', 'gpu', 'ai', 'network', 'utility', 'advanced', 'custom'];

export type CustomWidgetColumns = Partial<Record<
  'display_name' | 'description' | 'icon' | 'category' | 'default_size' | 'min_size' | 'refresh_interval' |
  'supports_linux' | 'supports_windows' | 'config_schema' | 'enabled', string | number>>;

function size(v: any): string | null {
  const w = Math.round(Number(v?.w));
  const h = Math.round(Number(v?.h));
  if (!(w >= 1 && w <= 48 && h >= 1 && h <= 48)) return null;
  return JSON.stringify({ w, h });
}

function schema(v: any): string | null {
  if (!Array.isArray(v) || v.length > 20) return null;
  const out = [];
  for (const f of v) {
    if (!f || typeof f.key !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/.test(f.key)) return null;
    if (!FIELD_TYPES.includes(f.type)) return null;
    out.push({
      key: f.key,
      label: String(f.label ?? f.key).slice(0, 80),
      type: f.type,
      ...(f.description ? { description: String(f.description).slice(0, 200) } : {}),
      ...(f.placeholder ? { placeholder: String(f.placeholder).slice(0, 100) } : {}),
      ...(f.default !== undefined ? { default: f.default } : {}),
      ...(Array.isArray(f.options) ? { options: f.options.map(String).slice(0, 30) } : {}),
    });
  }
  return JSON.stringify(out);
}

export function sanitizeCustomWidget(body: any, creating: boolean): { values: CustomWidgetColumns } | { error: string } {
  const values: CustomWidgetColumns = {};
  if (body?.display_name !== undefined || creating) {
    const name = String(body?.display_name ?? '').trim();
    if (!name || name.length > 80) return { error: 'display_name is required (max 80 characters)' };
    values.display_name = name;
  }
  if (body?.description !== undefined) values.description = String(body.description).slice(0, 300);
  if (body?.icon !== undefined) values.icon = String(body.icon).replace(/[^a-z0-9-]/g, '').slice(0, 40) || 'puzzle';
  if (body?.category !== undefined) {
    if (!CATEGORIES.includes(body.category)) return { error: 'Unknown category' };
    values.category = body.category;
  }
  for (const key of ['default_size', 'min_size'] as const) {
    if (body?.[key] !== undefined) {
      const s = size(body[key]);
      if (!s) return { error: `${key} must be {w, h} between 1 and 48` };
      values[key] = s;
    }
  }
  if (body?.refresh_interval !== undefined) {
    const r = Math.round(Number(body.refresh_interval));
    if (!(r >= 5 && r <= 3600)) return { error: 'refresh_interval must be 5-3600 seconds' };
    values.refresh_interval = r;
  }
  for (const key of ['supports_linux', 'supports_windows', 'enabled'] as const) {
    if (body?.[key] !== undefined) values[key] = body[key] ? 1 : 0;
  }
  if (body?.config_schema !== undefined) {
    const s = schema(body.config_schema);
    if (!s) return { error: 'config_schema must be a list of {key, label, type} fields' };
    values.config_schema = s;
  }
  if (values.supports_linux === 0 && values.supports_windows === 0) return { error: 'A widget must support at least one platform' };
  return { values };
}

/** Rows sent to the browser omit `spec`: it holds the commands a package widget runs. */
export function withoutSpec<T extends Record<string, unknown>>(row: T): Omit<T, 'spec'> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { spec, ...rest } = row;
  return rest;
}
