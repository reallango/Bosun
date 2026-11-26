/** Notification kinds grouped for the Activity filters. Kept client-safe (no database imports). */
export const NOTIFICATION_KIND_GROUPS: Record<string, readonly string[]> = {
  alerts: ['alert'],
  update: ['widget_update', 'widget_upgraded', 'bosun_update'],
  access: ['access_request', 'access_decision'],
  tasks: [],
};

/** Expand `alerts` / `update` / `access` / `tasks` (or a comma list of kinds) into notification kinds. */
export function kindsForFilter(raw: string | null | undefined): string[] | null {
  if (raw === null || raw === undefined || String(raw).trim() === '') return null;
  const out = new Set<string>();
  for (const part of String(raw).split(',').map(s => s.trim()).filter(Boolean)) {
    const group = NOTIFICATION_KIND_GROUPS[part];
    if (group) group.forEach(k => out.add(k));
    else out.add(part);
  }
  return Array.from(out);
}
