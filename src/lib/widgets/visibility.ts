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

export async function visibleWidgets<T extends { widget_type: string; server_id: string }>(auth: TokenPayload, rows: T[]): Promise<T[]> {
  if (auth.role === 'admin' || rows.length === 0) return rows;
  const servers = await visibleServerIds(auth);
  const dataPermission = new Map<string, string | null>();
  const out: T[] = [];
  for (const row of rows) {
    if (servers !== '*' && !servers.has(String(row.server_id))) continue;
    let perm = dataPermission.get(row.widget_type);
    if (perm === undefined) {
      perm = (await loadWidgetSpec(row.widget_type))?.spec.data.permission ?? null;
      dataPermission.set(row.widget_type, perm);
    }
    if (perm && !(await hasPermission(auth, perm, row.server_id))) continue;
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
