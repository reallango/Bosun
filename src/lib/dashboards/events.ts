/** Fired after a dashboard is created, renamed or deleted so the sidebar reloads its list. */
export const DASHBOARDS_CHANGED = 'bosun:dashboards-changed';

export function notifyDashboardsChanged() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(DASHBOARDS_CHANGED));
}

export const DASHBOARD_NAME_MAX = 60;
