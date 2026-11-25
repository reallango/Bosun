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

export type NotificationKind = 'alert' | 'widget_update' | 'widget_upgraded';
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
  server_id: string | null;
  created_at: string;
}

/** Insert a notification. Returns false when the dedupe key was already used. Never throws. */
export async function notify(n: NewNotification): Promise<boolean> {
  try {
    const r = await rqlite.execute(
      `INSERT OR IGNORE INTO notifications (id, server_id, severity, title, message, delivered_via, kind, link, dedupe_key, audience, data)
       VALUES (?, ?, ?, ?, ?, '["in_app"]', ?, ?, ?, ?, ?)`,
      [randomUUID(), n.serverId ?? null, n.severity, n.title.slice(0, 200), n.message.slice(0, 2000), n.kind,
        safeLink(n.link), n.dedupeKey ?? null, n.audience ?? null, n.data ? JSON.stringify(n.data) : null],
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
    server_id: row.server_id ? String(row.server_id) : null,
    created_at: String(row.created_at ?? ''),
  };
}

/** Whether `viewer` may see a row with this audience (NULL/unknown audience = everyone). */
export function audienceAllows(viewerRole: unknown, audience: unknown): boolean {
  return !isRole(audience) || hasRole(viewerRole, audience);
}

/** The newest notifications `viewer` may see (not dismissed). */
export async function listForViewer(viewer: TokenPayload, opts: { unreadOnly?: boolean; limit?: number } = {}): Promise<NotificationDto[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const rows = rowsToObjects(await rqlite.query(
    `SELECT id, kind, severity, title, message, link, is_read, server_id, audience, created_at FROM notifications
     WHERE is_dismissed = 0${opts.unreadOnly ? ' AND is_read = 0' : ''} ORDER BY created_at DESC LIMIT ?`,
    [limit * 2],
  ));
  const out: NotificationDto[] = [];
  const visible = new Map<string, boolean>();
  for (const row of rows) {
    if (!audienceAllows(viewer.role, row.audience)) continue;
    const sid = row.server_id ? String(row.server_id) : '';
    if (sid) {
      if (!visible.has(sid)) visible.set(sid, await serverVisible(viewer, sid).catch(() => false));
      if (!visible.get(sid)) continue;
    }
    out.push(toDto(row));
    if (out.length >= limit) break;
  }
  return out;
}

/** Mark one (by id) or all of the viewer's visible notifications read. */
export async function markRead(viewer: TokenPayload, id?: string): Promise<number> {
  const ids = id ? [id] : (await listForViewer(viewer, { unreadOnly: true, limit: 200 })).map(n => n.id);
  if (id) {
    const visible = (await listForViewer(viewer, { limit: 200 })).some(n => n.id === id);
    if (!visible) return 0;
  }
  if (!ids.length) return 0;
  const r = await rqlite.execute(`UPDATE notifications SET is_read = 1 WHERE id IN (${ids.map(() => '?').join(', ')})`, ids);
  return Number(r.rows_affected ?? 0);
}

/** Dismiss one notification the viewer can see. */
export async function dismiss(viewer: TokenPayload, id: string): Promise<boolean> {
  const visible = (await listForViewer(viewer, { limit: 200 })).some(n => n.id === id);
  if (!visible) return false;
  await rqlite.execute('UPDATE notifications SET is_read = 1, is_dismissed = 1 WHERE id = ?', [id]);
  return true;
}
