/**
 * In-app notifications (the bell). Metric alerts are written by the poller (lib/collect/alerts.js);
 * everything else goes through `notify` here.
 *
 * The table is shared by all users: there is no per-user read state. `audience` limits who sees a row
 * (NULL = everyone, otherwise the lowest access level), and rows about a server are hidden from callers
 * who cannot see that server.
 */
import { randomUUID } from 'crypto';
import type { TokenPayload } from '@/lib/auth/jwt';
import { hasRole, isRole, type Role } from '@/lib/auth/levels';
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';
import { serverVisible } from '@/lib/permissions/effective';
import { kindsForFilter } from './filters';

export { NOTIFICATION_KIND_GROUPS, kindsForFilter } from './filters';

export type NotificationKind = 'alert' | 'widget_update' | 'widget_upgraded' | 'access_request' | 'access_decision' | 'bosun_update';
export type NotificationSeverity = 'info' | 'success' | 'warning' | 'critical';

export interface NewNotification {
  kind: NotificationKind;
  severity: NotificationSeverity;
  title: string;
  message: string;
  /** In-app path opened when the notification is clicked, e.g. `/settings/widgets`. */
  link?: string | null;
  /** Raise at most once: a second notify with the same key is ignored. */
  dedupeKey?: string | null;
  /** Lowest access level that sees it; omitted = everyone. */
  audience?: Role | null;
  serverId?: string | null;
  data?: Record<string, unknown> | null;
  /** Only this user sees it (e.g. the decision on their own access request); omitted = per `audience`. */
  recipientUserId?: string | null;
}

/** What the bell shows. */
export interface NotificationDto {
  id: string;
  kind: string;
  type: 'info' | 'warning' | 'error' | 'success';
  title: string;
  message: string;
  link: string | null;
  read: boolean;
  /** Hidden from the bell; kept for the Activity history. */
  dismissed: boolean;
  server_id: string | null;
  created_at: string;
  /** access_request notices: the request to approve or deny. */
  request_id?: string | null;
}

/** Insert a notification. Returns false when the dedupe key was already used. Never throws. */
export async function notify(n: NewNotification): Promise<boolean> {
  try {
    const data = n.recipientUserId ? { ...(n.data ?? {}), [RECIPIENT]: String(n.recipientUserId) } : n.data;
    const r = await rqlite.execute(
      `INSERT OR IGNORE INTO notifications (id, server_id, severity, title, message, delivered_via, kind, link, dedupe_key, audience, data)
       VALUES (?, ?, ?, ?, ?, '["in_app"]', ?, ?, ?, ?, ?)`,
      [randomUUID(), n.serverId ?? null, n.severity, n.title.slice(0, 200), n.message.slice(0, 2000), n.kind,
        safeLink(n.link), n.dedupeKey ?? null, n.audience ?? null, data ? JSON.stringify(data) : null],
    );
    return Number(r.rows_affected ?? 0) > 0;
  } catch (err) {
    console.warn(`[notifications] could not record "${n.title}": ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

/** Mark notifications whose dedupe key starts with `prefix` as read and dismissed (the thing they announced is done). */
export async function resolveByKeyPrefix(prefix: string): Promise<void> {
  try {
    await rqlite.execute(
      `UPDATE notifications SET is_read = 1, is_dismissed = 1 WHERE dedupe_key LIKE ? ESCAPE '\\' AND is_dismissed = 0`,
      [`${prefix.replace(/[\\%_]/g, c => `\\${c}`)}%`],
    );
  } catch (err) {
    console.warn(`[notifications] could not resolve ${prefix}*: ${err instanceof Error ? err.message : err}`);
  }
}

/** Only in-app paths, so a notification can never send someone to another site. */
export function safeLink(link: string | null | undefined): string | null {
  if (!link || typeof link !== 'string') return null;
  return /^\/(?![/\\])[\w\-./?=&%#]*$/.test(link) ? link : null;
}

const TYPE_OF: Record<string, NotificationDto['type']> = { critical: 'error', error: 'error', warning: 'warning', success: 'success', info: 'info' };

export function toDto(row: Record<string, unknown>): NotificationDto {
  return {
    id: String(row.id),
    kind: String(row.kind ?? 'alert'),
    type: TYPE_OF[String(row.severity ?? 'info')] ?? 'info',
    title: String(row.title ?? ''),
    message: String(row.message ?? ''),
    link: safeLink(row.link as string | null),
    read: Number(row.is_read) === 1,
    dismissed: Number(row.is_dismissed) === 1,
    server_id: row.server_id ? String(row.server_id) : null,
    created_at: String(row.created_at ?? ''),
    ...(row.kind === 'access_request' ? { request_id: requestIdOf(row.data) } : {}),
  };
}

function requestIdOf(data: unknown): string | null {
  try { const d = typeof data === 'string' ? JSON.parse(data) : data; return typeof d?.requestId === 'string' ? d.requestId : null; } catch { return null; }
}

/** Key in `data` naming the only user who may see a personal notification. */
const RECIPIENT = 'recipientUserId';

/** The user a personal notification is for, or null for a shared one (also when `data` is missing or unreadable). */
export function recipientOf(data: unknown): string | null {
  if (data === null || data === undefined || data === '') return null;
  try {
    const d = typeof data === 'string' ? JSON.parse(data) : data;
    const v = d && typeof d === 'object' ? (d as Record<string, unknown>)[RECIPIENT] : undefined;
    return v === undefined || v === null ? null : String(v);
  } catch {
    return null;
  }
}

/** Whether `viewer` may see a row with this audience (NULL/unknown audience = everyone). */
export function audienceAllows(viewerRole: unknown, audience: unknown): boolean {
  return !isRole(audience) || hasRole(viewerRole, audience);
}

export interface ListForViewerOptions {
  unreadOnly?: boolean;
  limit?: number;
  /** Return every visible match instead of stopping at `limit`. */
  all?: boolean;
  /** One notification by id (still checked against the viewer's visibility rules). */
  id?: string | null;
  /** Include dismissed rows (the Activity page's history mode). */
  includeDismissed?: boolean;
  /** Alias for includeDismissed. */
  history?: boolean;
  /** Only rows older than this cursor (a `created_at` value from the previous page). */
  before?: string | null;
  /** Restrict to these notification kinds ([] means no notifications at all). */
  kinds?: readonly string[] | null;
  /** Comma list or array of kinds; `alerts` / `update` / `access` / `tasks` are accepted as groups. */
  kind?: string | readonly string[] | null;
  serverId?: string | null;
  /** Alias for serverId. */
  server?: string | null;
  /** Case-insensitive search in the title and message. */
  q?: string | null;
}

function parseWhen(value: string): number {
  const sqlite = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value);
  const direct = Date.parse(sqlite ? `${value.replace(' ', 'T')}Z` : value);
  if (!Number.isNaN(direct)) return direct;
  const spaced = Date.parse(`${value.replace(' ', 'T')}Z`);
  return Number.isNaN(spaced) ? 0 : spaced;
}

function kindsOf(opts: ListForViewerOptions): string[] | null {
  if (opts.kinds !== undefined) return opts.kinds === null ? null : [...opts.kinds];
  if (opts.kind === undefined || opts.kind === null) return null;
  const raw = opts.kind;
  return kindsForFilter(typeof raw === 'string' ? raw : raw.join(','));
}

/** The newest notifications `viewer` may see. Dismissed rows are left out unless asked for (history). */
export async function listForViewer(viewer: TokenPayload, opts: ListForViewerOptions = {}): Promise<NotificationDto[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const cap = opts.all ? Infinity : limit;
  const includeDismissed = opts.includeDismissed === true || opts.history === true;
  const kinds = kindsOf(opts);
  if (kinds !== null && kinds.length === 0) return [];
  const serverId = opts.serverId ?? opts.server ?? null;
  const q = opts.q?.trim().toLowerCase() || null;
  const beforeMs = opts.before ? parseWhen(opts.before) : null;
  const baseWhere = ['1=1'];
  const baseParams: unknown[] = [];
  if (opts.id) { baseWhere.push('id = ?'); baseParams.push(opts.id); }
  if (!includeDismissed) baseWhere.push('is_dismissed = 0');
  if (opts.unreadOnly) baseWhere.push('is_read = 0');
  const batch = Math.min(Math.max(limit * 4, 100), 500);
  const out: NotificationDto[] = [];
  const visible = new Map<string, boolean>();
  let lastCreated: string | null = null;
  let lastId: string | null = null;
  for (let page = 0; page < (opts.all ? 200 : 20) && out.length < cap; page++) {
    const where = [...baseWhere];
    const params = [...baseParams];
    if (lastCreated !== null) {
      // Continue after the last row of the previous batch, even when several share a timestamp.
      where.push('(created_at < ? OR (created_at = ? AND id < ?))');
      params.push(lastCreated, lastCreated, lastId);
    } else if (opts.before) {
      where.push('created_at < ?');
      params.push(opts.before);
    }
    params.push(batch);
    const fetched = rowsToObjects(await rqlite.query(
      `SELECT id, kind, severity, title, message, link, is_read, is_dismissed, server_id, audience, data, created_at FROM notifications
       WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`,
      params,
    )).sort((a, b) => parseWhen(String(b.created_at ?? '')) - parseWhen(String(a.created_at ?? '')));
    if (!fetched.length) break;
    for (const row of fetched) {
      if (!audienceAllows(viewer.role, row.audience)) continue;
      const recipient = recipientOf(row.data);
      if (recipient !== null && recipient !== String(viewer.userId)) continue;
      const dto = toDto(row);
      if (opts.id && dto.id !== opts.id) continue;
      if (!includeDismissed && dto.dismissed) continue;
      if (opts.unreadOnly && dto.read) continue;
      if (kinds !== null && !kinds.includes(dto.kind)) continue;
      if (serverId && dto.server_id !== serverId) continue;
      if (q && !`${dto.title}\n${dto.message}`.toLowerCase().includes(q)) continue;
      if (beforeMs !== null && parseWhen(dto.created_at) >= beforeMs) continue;
      const sid = dto.server_id ?? '';
      if (sid) {
        if (!visible.has(sid)) visible.set(sid, await serverVisible(viewer, sid).catch(() => false));
        if (!visible.get(sid)) continue;
      }
      out.push(dto);
      if (out.length >= cap) break;
    }
    if (fetched.length < batch) break;
    const last = fetched[fetched.length - 1];
    const nextCreated = String(last.created_at ?? '');
    const nextId = String(last.id ?? '');
    if (nextCreated === lastCreated && nextId === lastId) break;
    lastCreated = nextCreated;
    lastId = nextId;
  }
  return out;
}

/** A page of the Activity history: dismissed rows included, newest first, with a cursor for the next page. */
export async function listHistory(viewer: TokenPayload, opts: ListForViewerOptions = {}): Promise<{ notifications: NotificationDto[]; nextBefore: string | null }> {
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
  const page = await listForViewer(viewer, { ...opts, limit: limit + 1, includeDismissed: true });
  const hasMore = page.length > limit;
  const notifications = hasMore ? page.slice(0, limit) : page;
  return {
    notifications,
    nextBefore: hasMore ? notifications[notifications.length - 1]?.created_at ?? null : null,
  };
}

/** Mark one (by id) or all of the viewer's visible notifications read. */
export async function markRead(viewer: TokenPayload, id?: string): Promise<number> {
  if (id) {
    const visible = (await listForViewer(viewer, { id, limit: 1 })).length > 0;
    if (!visible) return 0;
    const r = await rqlite.execute('UPDATE notifications SET is_read = 1 WHERE id = ?', [id]);
    return Number(r.rows_affected ?? 0);
  }
  const ids = (await listForViewer(viewer, { unreadOnly: true, all: true })).map(n => n.id);
  if (!ids.length) return 0;
  const r = await rqlite.execute(`UPDATE notifications SET is_read = 1 WHERE id IN (${ids.map(() => '?').join(', ')})`, ids);
  return Number(r.rows_affected ?? 0);
}

/** Dismiss one notification the viewer can see. */
export async function dismiss(viewer: TokenPayload, id: string): Promise<boolean> {
  const visible = (await listForViewer(viewer, { id, limit: 1 })).length > 0;
  if (!visible) return false;
  await rqlite.execute('UPDATE notifications SET is_read = 1, is_dismissed = 1 WHERE id = ?', [id]);
  return true;
}

/** Put a dismissed notification back in the bell. */
export async function restore(viewer: TokenPayload, id: string): Promise<boolean> {
  const visible = (await listForViewer(viewer, { id, includeDismissed: true, limit: 1 })).length > 0;
  if (!visible) return false;
  await rqlite.execute('UPDATE notifications SET is_dismissed = 0, is_read = 0 WHERE id = ?', [id]);
  return true;
}
