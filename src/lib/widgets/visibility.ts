/**
 * Which widgets and dashboards a principal may see.
 *
 * A widget is shown only when its server is visible to the caller (no `servers.view` deny), and,
 * for package widgets, only when the caller holds the widget's data permission for that server.
 * Full access sees everything. Pure filtering over rows already read; server side only.
 */
import type { TokenPayload } from '@/lib/auth/jwt';
import { hasPermission } from '@/lib/permissions/authorize';
import { visibleServerIds } from '@/lib/permissions/effective';
import { loadWidgetSpec } from '@/lib/widgets/runtime/execute';
import { viewFilter } from '@/lib/widgets/runtime/resource-check';
import type { ResourceFields } from '@/lib/widgets/runtime/resources';

export async function visibleWidgets<T extends { widget_type: string; server_id: string }>(auth: TokenPayload, rows: T[]): Promise<T[]> {
  if (auth.role === 'admin' || rows.length === 0) return rows;
  const servers = await visibleServerIds(auth);
  const dataSpec = new Map<string, { perm: string; resources?: ResourceFields } | null>();
  const out: T[] = [];
  for (const row of rows) {
    if (servers !== '*' && !servers.has(String(row.server_id))) continue;
    let d = dataSpec.get(row.widget_type);
    if (d === undefined) {
      const spec = (await loadWidgetSpec(row.widget_type))?.spec.data;
      d = spec?.permission ? { perm: spec.permission, ...(spec.resources ? { resources: spec.resources } : {}) } : null;
      dataSpec.set(row.widget_type, d);
    }
    // Shown when the caller may see any of it: for a list of stacks/containers, a view limited to some of them counts.
    if (d && !(await hasPermission(auth, d.perm, row.server_id)) && !(d.resources && (await viewFilter(auth, d.perm, row.server_id, d.resources)))) continue;
    out.push(row);
  }
  return out;
}

/** Dashboards of servers the caller may not see are not listed. */
export async function visibleDashboards<T extends { type?: unknown; server_id?: unknown }>(auth: TokenPayload, rows: T[]): Promise<T[]> {
  if (auth.role === 'admin') return rows;
  const servers = await visibleServerIds(auth);
  if (servers === '*') return rows;
  return rows.filter(r => r.type !== 'server' || (r.server_id != null && servers.has(String(r.server_id))));
}

/**
 * Whether one widget (by id) exists for this caller: its server is visible and, for a package widget, the caller holds its data
 * permission. Routes that read or change a widget by id answer 404 otherwise, as if it did not exist.
 */
export async function widgetVisible(auth: TokenPayload, widgetId: string): Promise<boolean> {
  const { rqlite, rowsToObjects } = await import('@/lib/db/rqlite-client');
  const rows = rowsToObjects(await rqlite.query('SELECT widget_type, server_id FROM widgets WHERE id = ?', [widgetId])) as unknown as { widget_type: string; server_id: string }[];
  return rows.length > 0 && (await visibleWidgets(auth, rows)).length > 0;
}