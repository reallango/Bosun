/**
 * The bell's grouping rules. Kept as a pure function so the sections and their ordering can be
 * tested without React: one place decides what needs attention, what is new, and what is history.
 */

export type BellTaskStatus = 'running' | 'success' | 'error' | 'cancelled' | 'lost';

export interface BellNotification {
  id: string;
  kind: string;
  type: string;
  title: string;
  message: string;
  link?: string | null;
  request_id?: string | null;
  read: boolean;
  created_at: string;
  dismissed?: boolean;
}

export interface BellTask {
  id: string;
  status: BellTaskStatus;
  actionLabel: string;
  serverName: string;
  message: string | null;
  steps: string[];
  percent: number | null;
  startedAt: number;
  finishedAt: number | null;
  screenId?: string | null;
  widgetId?: string | null;
  startedBy?: string | null;
  dismissed?: boolean;
}

export type BellItem =
  | { type: 'notification'; at: number; notification: BellNotification }
  | { type: 'task'; at: number; task: BellTask };

export interface BellGroups {
  attention: BellItem[];
  running: BellItem[];
  newItems: BellItem[];
  earlier: BellItem[];
  counts: {
    unread: number;
    unseen: number;
    failedUnseen: number;
    attention: number;
    running: number;
    badge: number;
  };
}

export const EARLIER_WINDOW_MS = 24 * 60 * 60 * 1000;
export const EARLIER_LIMIT = 10;

/** SQLite's CURRENT_TIMESTAMP has no timezone marker; treat it as UTC, like SQLite does. */
export function notificationTime(createdAt: string): number {
  const sqlite = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(createdAt);
  const direct = Date.parse(sqlite ? `${createdAt.replace(' ', 'T')}Z` : createdAt);
  if (!Number.isNaN(direct)) return direct;
  const spaced = Date.parse(`${createdAt.replace(' ', 'T')}Z`);
  return Number.isNaN(spaced) ? 0 : spaced;
}

export function taskTime(task: BellTask): number {
  return task.finishedAt ?? task.startedAt;
}

export function isPendingAccessRequest(n: BellNotification): boolean {
  return n.kind === 'access_request' && !!n.request_id;
}

export function isFailedTask(t: BellTask): boolean {
  return t.status === 'error' || t.status === 'lost';
}

export function bellItemKey(item: BellItem): string {
  return item.type === 'notification' ? `n:${item.notification.id}` : `t:${item.task.id}`;
}

const newestFirst = (a: BellItem, b: BellItem) => b.at - a.at;
const notificationItem = (notification: BellNotification): BellItem => ({
  type: 'notification', at: notificationTime(notification.created_at), notification,
});
const taskItem = (task: BellTask): BellItem => ({ type: 'task', at: taskTime(task), task });

export function groupBell(input: {
  notifications: readonly BellNotification[];
  tasks: readonly BellTask[];
  seen: ReadonlySet<string>;
  now?: number;
  earlierLimit?: number;
}): BellGroups {
  const now = input.now ?? Date.now();
  const since = now - EARLIER_WINDOW_MS;
  const visibleNotifications = input.notifications.filter(n => !n.dismissed);
  const visibleTasks = input.tasks.filter(t => !t.dismissed);

  // Access requests stay at the top until they are decided or dismissed, even after "mark all as read".
  const attentionNotifications = visibleNotifications
    .filter(isPendingAccessRequest)
    .map(notificationItem)
    .sort(newestFirst);
  const attentionTasks = visibleTasks
    .filter(t => !input.seen.has(t.id) && isFailedTask(t))
    .map(taskItem)
    .sort(newestFirst);
  const attention = [...attentionNotifications, ...attentionTasks];

  const running = visibleTasks
    .filter(t => t.status === 'running')
    .map(taskItem)
    .sort(newestFirst);

  const newItems = [
    ...visibleNotifications
      .filter(n => !n.read && !isPendingAccessRequest(n))
      .map(notificationItem),
    ...visibleTasks
      .filter(t => t.status !== 'running' && !input.seen.has(t.id) && !isFailedTask(t))
      .map(taskItem),
  ].sort(newestFirst);

  const earlier = [
    ...visibleNotifications
      .filter(n => n.read && !isPendingAccessRequest(n) && notificationTime(n.created_at) >= since)
      .map(notificationItem),
    ...visibleTasks
      .filter(t => t.status !== 'running' && input.seen.has(t.id) && taskTime(t) >= since)
      .map(taskItem),
  ]
    .sort(newestFirst)
    .slice(0, Math.max(0, input.earlierLimit ?? EARLIER_LIMIT));

  const unread = visibleNotifications.filter(n => !n.read).length;
  const failedUnseen = visibleTasks.filter(t => !input.seen.has(t.id) && isFailedTask(t)).length;
  const unseen = visibleTasks.filter(t => t.status !== 'running' && !input.seen.has(t.id)).length;

  return {
    attention,
    running,
    newItems,
    earlier,
    counts: {
      unread,
      unseen,
      failedUnseen,
      attention: attention.length,
      running: running.length,
      badge: unread + failedUnseen,
    },
  };
}
