/**
 * Jobs as the notification area shows them ("tasks"): who may see one, and the summary the browser gets. A job is visible to the
 * person who started it and to anyone who may run the action it belongs to; its log and the way back to its screen need the same.
 */
import type { TokenPayload } from '@/lib/auth/jwt';
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';
import { hasPermission } from '@/lib/permissions/authorize';
import { serverVisible } from '@/lib/permissions/effective';
import { loadWidgetSpec } from '@/lib/widgets/runtime/execute';
import { decryptOrigin } from '@/lib/widgets/jobs/origin';
import { getOriginEnc, type JobRecord } from '@/lib/widgets/jobs/store';

export interface Task {
  id: string;
  widgetType: string;
  widgetName: string;
  actionId: string;
  actionLabel: string;
  serverId: string;
  serverName: string;
  widgetId: string | null;
  status: JobRecord['status'];
  steps: string[];
  percent: number | null;
  message: string | null;
  startedAt: number;
  finishedAt: number | null;
  /** The screen the job was started from, when it can be reopened (the person has the saved values). */
  screenId: string | null;
  cancelRequested: boolean;
}

export async function mayUse(auth: TokenPayload, j: JobRecord): Promise<boolean> {
  const loaded = await loadWidgetSpec(j.widgetType);
  const action = loaded?.spec.actions.find(a => a.id === j.actionId);
  if (!loaded || !action) return auth.role === 'admin' || j.userId === auth.userId;
  if (!(await serverVisible(auth, j.serverId))) return false;
  return (j.userId !== null && j.userId === auth.userId) || (await hasPermission(auth, action.permission, j.serverId));
}

export async function toTask(j: JobRecord, auth: TokenPayload, names: { servers: Map<string, string>; widgets: Map<string, string> }): Promise<Task> {
  const loaded = await loadWidgetSpec(j.widgetType);
  const action = loaded?.spec.actions.find(a => a.id === j.actionId);
  let screenId: string | null = null;
  if (j.hasOrigin && j.widgetId && (j.userId === auth.userId || auth.role === 'admin')) {
    const origin = decryptOrigin(await getOriginEnc(j.id));
    if (origin && loaded?.spec.screens?.[origin.screenId]) screenId = origin.screenId;
  }
  return {
    id: j.id, widgetType: j.widgetType, widgetName: names.widgets.get(j.widgetType) ?? j.widgetType, actionId: j.actionId, actionLabel: action?.label ?? j.actionId,
    serverId: j.serverId, serverName: names.servers.get(j.serverId) ?? 'a server', widgetId: j.widgetId, status: j.status, steps: j.steps.slice(-4), percent: j.percent,
    message: j.message, startedAt: j.startedAt, finishedAt: j.finishedAt, screenId, cancelRequested: j.cancelRequested,
  };
}

export async function nameMaps(): Promise<{ servers: Map<string, string>; widgets: Map<string, string> }> {
  const servers = new Map(rowsToObjects(await rqlite.query('SELECT id, name FROM servers')).map(r => [String(r.id), String(r.name)]));
  const widgets = new Map(rowsToObjects(await rqlite.query('SELECT type, display_name FROM custom_widgets')).map(r => [String(r.type), String(r.display_name)]));
  return { servers, widgets };
}
