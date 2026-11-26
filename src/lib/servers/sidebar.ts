/**
 * Pure helpers for the sidebar server list: health, ordering and the second
 * line under a server name. No React or fetch code here so it stays testable.
 */

export interface SidebarServer {
  id: string;
  name: string;
  hostname?: string | null;
  is_online: number | boolean;
  /** false = monitoring paused (shown as a warning). */
  poll_enabled?: boolean;
  last_seen?: string | null;
}

export type ServerHealth = 'online' | 'offline' | 'paused';

export function serverHealth(
  server: Pick<SidebarServer, 'is_online' | 'poll_enabled'>
): ServerHealth {
  if (server.poll_enabled === false) return 'paused';
  return server.is_online ? 'online' : 'offline';
}

export function serverStatusLabel(health: ServerHealth): string {
  if (health === 'paused') return 'monitoring paused';
  return health;
}

/**
 * rqlite's CURRENT_TIMESTAMP is UTC without a zone marker ("YYYY-MM-DD HH:MM:SS"),
 * which `Date.parse` would otherwise read as local time. Other writers store ISO
 * strings with a Z, so only add the marker when none is present.
 */
export function parseServerTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  let text = String(value).trim();
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(?:\.\d+)?)?$/.test(text)) {
    text = text.replace(' ', 'T') + 'Z';
  }
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

/** "offline 4 min", "offline 2 h", "offline 3 d", or plain "offline" without a timestamp. */
export function offlineAgeText(
  lastSeen: string | null | undefined,
  now: number | Date = Date.now()
): string {
  const seen = parseServerTimestamp(lastSeen);
  if (seen === null) return 'offline';
  const nowMs = typeof now === 'number' ? now : now.getTime();
  const seconds = Math.max(0, Math.floor((nowMs - seen) / 1000));
  if (seconds < 60) return 'offline <1 min';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `offline ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `offline ${hours} h`;
  return `offline ${Math.floor(hours / 24)} d`;
}

/** Hostname while online; how long it has been offline otherwise. */
export function serverSubtitle(
  server: Pick<SidebarServer, 'hostname' | 'is_online' | 'last_seen'>,
  now: number | Date = Date.now()
): string {
  if (!server.is_online) return offlineAgeText(server.last_seen, now);
  return server.hostname?.trim() ?? '';
}

/** Offline and paused servers first, then by name (case-insensitive); id breaks ties. */
export function sortServersForSidebar<T extends SidebarServer>(servers: readonly T[]): T[] {
  const rank = (server: T) => (serverHealth(server) === 'online' ? 1 : 0);
  return [...servers].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) ||
      a.id.localeCompare(b.id)
  );
}
