/**
 * The logic behind a widget's full-page screen (ScreenPage), kept apart from React so it can be tested: how old the
 * loaded data is, which servers offer the same screen, and how an action runner's message reads as a toast.
 */

/** A placement of a widget (a row of the API below), with the names its query joins in. */
export interface InstanceRow {
  id: string;
  widget_type: string;
  server_id: string;
  server_name?: string | null;
  dashboard_id: string | null;
  dashboard_name?: string | null;
  dashboard_type?: string | null;
  dashboard_server_id?: string | null;
}

/** One place a widget type is used, as GET /api/widgets/instances returns it. */
export interface WidgetInstance {
  id: string;
  widget_type: string;
  server_id: string;
  server_name: string | null;
  dashboard_id: string;
  dashboard_name: string | null;
}

export interface InstanceChoice {
  id: string;
  label: string;
}

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

const shortId = (id: string) => id.slice(0, 8);

/** What a server is called when its name is missing (it always has an id). */
export function serverLabel(instance: WidgetInstance): string {
  return instance.server_name ?? (instance.server_id ? `Server ${shortId(instance.server_id)}` : 'Server');
}

/**
 * The instances a caller may open: only widgets on a dashboard they can see. Rows arrive from the query behind
 * GET /api/widgets/instances; this keeps the choice of what to show testable.
 */
export function listInstances(rows: InstanceRow[], visibleDashboardIds: ReadonlySet<string>): WidgetInstance[] {
  const seen = new Set<string>();
  const out: WidgetInstance[] = [];
  for (const row of rows) {
    const dashboardId = text(row.dashboard_id);
    if (!dashboardId || !visibleDashboardIds.has(dashboardId) || seen.has(row.id)) continue;
    seen.add(row.id);
    out.push({
      id: row.id,
      widget_type: row.widget_type,
      server_id: text(row.server_id) ?? '',
      server_name: text(row.server_name),
      dashboard_id: dashboardId,
      dashboard_name: text(row.dashboard_name),
    });
  }
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return out.sort((a, b) => cmp(serverLabel(a), serverLabel(b)) || cmp(a.dashboard_name ?? '', b.dashboard_name ?? '') || cmp(a.id, b.id));
}

/**
 * The entries of the server switcher: the server name, and the dashboard too when that server has more than one
 * placement of the widget (so the two entries stay apart). Labels stay unique even then.
 */
export function instanceChoices(instances: WidgetInstance[]): InstanceChoice[] {
  const servers = new Map<string, number>();
  for (const i of instances) servers.set(serverLabel(i), (servers.get(serverLabel(i)) ?? 0) + 1);
  const labelled = instances.map(i => {
    const server = serverLabel(i);
    const label = (servers.get(server) ?? 0) > 1 ? `${server} — ${i.dashboard_name ?? 'Dashboard'}` : server;
    return { id: i.id, label };
  });
  const counts = new Map<string, number>();
  for (const c of labelled) counts.set(c.label, (counts.get(c.label) ?? 0) + 1);
  return labelled.map(c => ((counts.get(c.label) ?? 0) > 1 ? { id: c.id, label: `${c.label} (${shortId(c.id)})` } : c));
}

/** "updated 5 s ago": a short, human age for the screen's loaded data. */
export function formatAge(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 2) return 'just now';
  if (s < 60) return `${s} s ago`;
  const minutes = Math.floor(s / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

/** Whole seconds since a load, never negative (the client clock may be behind). */
export function ageSeconds(loadedAt: number, now: number): number {
  return Math.max(0, Math.floor((now - loadedAt) / 1000));
}

/**
 * Whether an action runner message is a failure. The runner reports a started job and a short result as a plain
 * string too, so only the wording it uses for failures picks the error style.
 */
export function noticeToastVariant(notice: string): 'default' | 'error' {
  return /\b(failed|cannot|could not|not available|no terminal token|nothing to open|unavailable)\b/i.test(notice) ? 'error' : 'default';
}
