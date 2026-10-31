/** Fired after a dashboard is created, renamed or deleted so the sidebar reloads its list. */
export const DASHBOARDS_CHANGED = 'bosun:dashboards-changed';

export function notifyDashboardsChanged() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(DASHBOARDS_CHANGED));
}

export const DASHBOARD_NAME_MAX = 60;

/** Fired after a server is added, edited or removed so the sidebar reloads its list at once (it also refreshes on a timer, for online status). */
export const SERVERS_CHANGED = 'bosun:servers-changed';

export function notifyServersChanged() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(SERVERS_CHANGED));
}
