/**
 * Database reads for the permission system, cached briefly like the user-status and
 * API-key caches (changes made through this process invalidate at once; another
 * cluster node's changes apply within TTL_MS).
 */
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';
import type { PermissionDef } from './catalog';
import type { Grant, GrantScope, ServerContext } from './evaluate';

const TTL_MS = 30_000;
const MAX_ENTRIES = 2000;

export interface Principal {
  kind: 'user' | 'api_key';
  id: string;
}

interface Cache {
  grants: Map<string, { at: number; grants: Grant[] }>;
  serverGroups: Map<string, { at: number; ids: string[] }>;
  defs: { at: number; defs: PermissionDef[] } | null;
}

const g = globalThis as unknown as { __bosunPermissions?: Cache };
const cache: Cache = g.__bosunPermissions ?? (g.__bosunPermissions = { grants: new Map(), serverGroups: new Map(), defs: null });

/** Forget everything cached (after changing groups, memberships or definitions here). */
export function invalidatePermissionCache(): void {
  cache.grants.clear();
  cache.serverGroups.clear();
  cache.defs = null;
}

function toScope(type: unknown, id: unknown): GrantScope | null {
  if (type === 'all') return { type: 'all' };
  if ((type === 'server' || type === 'server_group') && typeof id === 'string' && id) return { type, id };
  return null;
}

/** Grants a principal holds through its permission groups (not counting its access level). */
export async function loadGroupGrants(p: Principal): Promise<Grant[]> {
  const key = `${p.kind}:${p.id}`;
  const hit = cache.grants.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.grants;

  const sql = p.kind === 'user'
    ? 'SELECT gr.permission, gr.scope_type, gr.scope_id, gr.effect FROM permission_grants gr JOIN user_groups m ON m.group_id = gr.group_id WHERE m.user_id = ?'
    : 'SELECT gr.permission, gr.scope_type, gr.scope_id, gr.effect FROM permission_grants gr JOIN api_key_groups m ON m.group_id = gr.group_id WHERE m.api_key_id = ?';
  const r = await rqlite.query(sql, [p.id]);
  const grants: Grant[] = [];
  for (const row of rowsToObjects(r) as Array<{ permission: string; scope_type: string; scope_id: string; effect: string }>) {
    const scope = toScope(row.scope_type, row.scope_id);
    if (scope) grants.push({ permission: row.permission, scope, effect: row.effect === 'deny' ? 'deny' : 'allow' });
  }
  if (cache.grants.size > MAX_ENTRIES) cache.grants.clear();
  cache.grants.set(key, { at: Date.now(), grants });
  return grants;
}

/** Ids of the server groups a server belongs to. */
export async function serverGroupIds(serverId: string): Promise<string[]> {
  const hit = cache.serverGroups.get(serverId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.ids;
  const r = await rqlite.query('SELECT server_group_id FROM server_group_members WHERE server_id = ?', [serverId]);
  const ids = (r.values || []).map(v => String(v[0]));
  if (cache.serverGroups.size > MAX_ENTRIES) cache.serverGroups.clear();
  cache.serverGroups.set(serverId, { at: Date.now(), ids });
  return ids;
}

export async function serverContext(serverId: string): Promise<ServerContext> {
  return { id: serverId, groupIds: await serverGroupIds(serverId) };
}

/** Every server with its groups (for showing what a principal may do where). */
export async function allServerContexts(): Promise<ServerContext[]> {
  const [servers, members] = await Promise.all([
    rqlite.query('SELECT id FROM servers'),
    rqlite.query('SELECT server_id, server_group_id FROM server_group_members'),
  ]);
  const byServer = new Map<string, string[]>();
  for (const [sid, gid] of members.values || []) {
    const k = String(sid);
    byServer.set(k, [...(byServer.get(k) || []), String(gid)]);
  }
  return (servers.values || []).map(v => ({ id: String(v[0]), groupIds: byServer.get(String(v[0])) || [] }));
}

/** Permissions registered by installed widget packages. A failed read means none (never an error). */
export async function registeredPermissionDefs(): Promise<PermissionDef[]> {
  if (cache.defs && Date.now() - cache.defs.at < TTL_MS) return cache.defs.defs;
  let defs: PermissionDef[] = [];
  try {
    const r = await rqlite.query('SELECT id, source, label, description, group_name, default_level, risk, scope, implies FROM permission_definitions');
    defs = (rowsToObjects(r) as Array<Record<string, string>>).map(row => {
      let implies: string[] = [];
      try { implies = JSON.parse(row.implies || '[]'); } catch { /* none */ }
      return {
        id: row.id, source: row.source, label: row.label, description: row.description, group: row.group_name,
        defaultLevel: row.default_level as PermissionDef['defaultLevel'], risk: row.risk as PermissionDef['risk'],
        scope: row.scope as PermissionDef['scope'], implies,
      };
    });
  } catch (err) {
    console.error('Reading permission definitions failed:', err);
  }
  cache.defs = { at: Date.now(), defs };
  return defs;
}
