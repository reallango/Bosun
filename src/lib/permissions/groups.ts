/**
 * Permission groups, server groups and who holds them (server-side only).
 *
 * rqlite does not enforce foreign keys by default, so deletes clean up their
 * dependents explicitly, and every multi-row change is one transaction.
 */
import crypto from 'crypto';
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';
import type { Grant } from './evaluate';
import type { GroupInput, ServerGroupInput } from './validate';
import { invalidatePermissionCache } from './store';

export interface GroupDto {
  id: string;
  name: string;
  description: string | null;
  grants: Grant[];
  user_count: number;
  api_key_count: number;
  created_at: string | null;
  updated_at: string | null;
}

export interface ServerGroupDto {
  id: string;
  name: string;
  description: string | null;
  server_ids: string[];
  created_at: string | null;
}

/** A name that is already taken (UNIQUE constraint). */
export class DuplicateNameError extends Error {
  constructor(what: string) {
    super(`A ${what} with that name already exists`);
    this.name = 'DuplicateNameError';
  }
}

const isUnique = (err: unknown) => /UNIQUE constraint failed/i.test(String((err as Error)?.message));
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const grantRow = (groupId: string, g: Grant) => ({
  sql: 'INSERT OR IGNORE INTO permission_grants (id, group_id, permission, scope_type, scope_id) VALUES (?, ?, ?, ?, ?)',
  params: [crypto.randomUUID(), groupId, g.permission, g.scope.type, g.scope.type === 'all' ? '' : g.scope.id],
});

// ---------------------------------------------------------------- permission groups

export async function listGroups(): Promise<GroupDto[]> {
  const [groups, grants, users, keys] = await Promise.all([
    rqlite.query('SELECT id, name, description, created_at, updated_at FROM permission_groups ORDER BY name COLLATE NOCASE'),
    rqlite.query('SELECT group_id, permission, scope_type, scope_id FROM permission_grants ORDER BY permission'),
    rqlite.query('SELECT group_id, COUNT(*) AS n FROM user_groups GROUP BY group_id'),
    rqlite.query('SELECT group_id, COUNT(*) AS n FROM api_key_groups GROUP BY group_id'),
  ]);
  const grantsBy = new Map<string, Grant[]>();
  for (const r of rowsToObjects(grants)) {
    const type = String(r.scope_type);
    const scope = type === 'all' ? { type: 'all' as const } : { type: type as 'server' | 'server_group', id: String(r.scope_id) };
    const k = String(r.group_id);
    grantsBy.set(k, [...(grantsBy.get(k) || []), { permission: String(r.permission), scope }]);
  }
  const count = (res: Awaited<ReturnType<typeof rqlite.query>>) =>
    new Map(rowsToObjects(res).map(r => [String(r.group_id), Number(r.n) || 0]));
  const userCount = count(users);
  const keyCount = count(keys);
  return rowsToObjects(groups).map(r => ({
    id: String(r.id),
    name: String(r.name),
    description: str(r.description),
    grants: grantsBy.get(String(r.id)) || [],
    user_count: userCount.get(String(r.id)) || 0,
    api_key_count: keyCount.get(String(r.id)) || 0,
    created_at: str(r.created_at),
    updated_at: str(r.updated_at),
  }));
}

export async function getGroup(id: string): Promise<GroupDto | null> {
  return (await listGroups()).find(g => g.id === id) ?? null;
}

export async function createGroup(input: GroupInput, createdBy: string | null): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  try {
    await rqlite.executeBatch([
      { sql: 'INSERT INTO permission_groups (id, name, description, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        params: [id, input.name, input.description ?? null, createdBy, now, now] },
      ...(input.grants || []).map(g => grantRow(id, g)),
    ], { transaction: true });
  } catch (err) {
    if (isUnique(err)) throw new DuplicateNameError('permission group');
    throw err;
  }
  invalidatePermissionCache();
  return id;
}

/** Update name/description and, when given, replace the grants. Returns false when the group does not exist. */
export async function updateGroup(id: string, input: GroupInput): Promise<boolean> {
  const exists = await rqlite.query('SELECT 1 FROM permission_groups WHERE id = ?', [id]);
  if (!exists.values?.length) return false;
  const now = new Date().toISOString();
  const statements: Array<{ sql: string; params?: unknown[] }> = [];
  if (input.name !== undefined || input.description !== undefined) {
    const sets: string[] = ['updated_at = ?'];
    const params: unknown[] = [now];
    if (input.name !== undefined) { sets.push('name = ?'); params.push(input.name); }
    if (input.description !== undefined) { sets.push('description = ?'); params.push(input.description); }
    statements.push({ sql: `UPDATE permission_groups SET ${sets.join(', ')} WHERE id = ?`, params: [...params, id] });
  } else if (input.grants !== undefined) {
    statements.push({ sql: 'UPDATE permission_groups SET updated_at = ? WHERE id = ?', params: [now, id] });
  }
  if (input.grants !== undefined) {
    statements.push({ sql: 'DELETE FROM permission_grants WHERE group_id = ?', params: [id] });
    statements.push(...input.grants.map(g => grantRow(id, g)));
  }
  if (!statements.length) return true;
  try {
    await rqlite.executeBatch(statements, { transaction: true });
  } catch (err) {
    if (isUnique(err)) throw new DuplicateNameError('permission group');
    throw err;
  }
  invalidatePermissionCache();
  return true;
}

export async function deleteGroup(id: string): Promise<boolean> {
  const exists = await rqlite.query('SELECT 1 FROM permission_groups WHERE id = ?', [id]);
  if (!exists.values?.length) return false;
  await rqlite.executeBatch([
    { sql: 'DELETE FROM permission_grants WHERE group_id = ?', params: [id] },
    { sql: 'DELETE FROM user_groups WHERE group_id = ?', params: [id] },
    { sql: 'DELETE FROM api_key_groups WHERE group_id = ?', params: [id] },
    { sql: 'DELETE FROM permission_groups WHERE id = ?', params: [id] },
  ], { transaction: true });
  invalidatePermissionCache();
  return true;
}

// ---------------------------------------------------------------- assignments

/** Which of these group ids exist? */
async function existingGroupIds(ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const r = await rqlite.query(`SELECT id FROM permission_groups WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
  return new Set((r.values || []).map(v => String(v[0])));
}

/** Groups a user or API key holds, by principal id. */
export async function groupIdsByPrincipal(kind: 'user' | 'api_key'): Promise<Map<string, string[]>> {
  const r = await rqlite.query(kind === 'user'
    ? 'SELECT user_id AS pid, group_id FROM user_groups'
    : 'SELECT api_key_id AS pid, group_id FROM api_key_groups');
  const out = new Map<string, string[]>();
  for (const row of rowsToObjects(r)) {
    const k = String(row.pid);
    out.set(k, [...(out.get(k) || []), String(row.group_id)]);
  }
  return out;
}

/** Replace the groups of a user or API key. Throws if a group id does not exist. */
export async function setPrincipalGroups(kind: 'user' | 'api_key', principalId: string, groupIds: string[]): Promise<void> {
  const known = await existingGroupIds(groupIds);
  const missing = groupIds.filter(g => !known.has(g));
  if (missing.length) throw Object.assign(new Error('Unknown permission group'), { status: 400, code: 'VALIDATION' });
  const table = kind === 'user' ? 'user_groups' : 'api_key_groups';
  const col = kind === 'user' ? 'user_id' : 'api_key_id';
  await rqlite.executeBatch([
    { sql: `DELETE FROM ${table} WHERE ${col} = ?`, params: [principalId] },
    ...groupIds.map(g => ({ sql: `INSERT OR IGNORE INTO ${table} (${col}, group_id) VALUES (?, ?)`, params: [principalId, g] })),
  ], { transaction: true });
  invalidatePermissionCache();
}

/** Remove everything a deleted user or API key held. */
export async function clearPrincipalGroups(kind: 'user' | 'api_key', principalId: string): Promise<void> {
  await rqlite.execute(`DELETE FROM ${kind === 'user' ? 'user_groups WHERE user_id' : 'api_key_groups WHERE api_key_id'} = ?`, [principalId]);
  invalidatePermissionCache();
}

// ---------------------------------------------------------------- server groups

export async function listServerGroups(): Promise<ServerGroupDto[]> {
  const [groups, members] = await Promise.all([
    rqlite.query('SELECT id, name, description, created_at FROM server_groups ORDER BY name COLLATE NOCASE'),
    rqlite.query('SELECT server_group_id, server_id FROM server_group_members'),
  ]);
  const by = new Map<string, string[]>();
  for (const r of rowsToObjects(members)) {
    const k = String(r.server_group_id);
    by.set(k, [...(by.get(k) || []), String(r.server_id)]);
  }
  return rowsToObjects(groups).map(r => ({
    id: String(r.id), name: String(r.name), description: str(r.description), server_ids: by.get(String(r.id)) || [], created_at: str(r.created_at),
  }));
}

async function assertServersExist(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const r = await rqlite.query(`SELECT id FROM servers WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
  if ((r.values || []).length !== ids.length) throw Object.assign(new Error('Unknown server'), { status: 400, code: 'VALIDATION' });
}

export async function createServerGroup(input: ServerGroupInput): Promise<string> {
  await assertServersExist(input.server_ids || []);
  const id = crypto.randomUUID();
  try {
    await rqlite.executeBatch([
      { sql: 'INSERT INTO server_groups (id, name, description) VALUES (?, ?, ?)', params: [id, input.name, input.description ?? null] },
      ...(input.server_ids || []).map(s => ({ sql: 'INSERT OR IGNORE INTO server_group_members (server_group_id, server_id) VALUES (?, ?)', params: [id, s] })),
    ], { transaction: true });
  } catch (err) {
    if (isUnique(err)) throw new DuplicateNameError('server group');
    throw err;
  }
  invalidatePermissionCache();
  return id;
}

export async function updateServerGroup(id: string, input: ServerGroupInput): Promise<boolean> {
  const exists = await rqlite.query('SELECT 1 FROM server_groups WHERE id = ?', [id]);
  if (!exists.values?.length) return false;
  if (input.server_ids) await assertServersExist(input.server_ids);
  const statements: Array<{ sql: string; params?: unknown[] }> = [];
  const sets: string[] = [];
  const params: unknown[] = [];
  if (input.name !== undefined) { sets.push('name = ?'); params.push(input.name); }
  if (input.description !== undefined) { sets.push('description = ?'); params.push(input.description); }
  if (sets.length) statements.push({ sql: `UPDATE server_groups SET ${sets.join(', ')} WHERE id = ?`, params: [...params, id] });
  if (input.server_ids) {
    statements.push({ sql: 'DELETE FROM server_group_members WHERE server_group_id = ?', params: [id] });
    statements.push(...input.server_ids.map(s => ({ sql: 'INSERT OR IGNORE INTO server_group_members (server_group_id, server_id) VALUES (?, ?)', params: [id, s] })));
  }
  if (!statements.length) return true;
  try {
    await rqlite.executeBatch(statements, { transaction: true });
  } catch (err) {
    if (isUnique(err)) throw new DuplicateNameError('server group');
    throw err;
  }
  invalidatePermissionCache();
  return true;
}

/** Delete a server group, its memberships and every grant that was scoped to it. */
export async function deleteServerGroup(id: string): Promise<boolean> {
  const exists = await rqlite.query('SELECT 1 FROM server_groups WHERE id = ?', [id]);
  if (!exists.values?.length) return false;
  await rqlite.executeBatch([
    { sql: "DELETE FROM permission_grants WHERE scope_type = 'server_group' AND scope_id = ?", params: [id] },
    { sql: 'DELETE FROM server_group_members WHERE server_group_id = ?', params: [id] },
    { sql: 'DELETE FROM server_groups WHERE id = ?', params: [id] },
  ], { transaction: true });
  invalidatePermissionCache();
  return true;
}

/** Remove a deleted server from every group and every grant scoped to it. */
export async function forgetServer(serverId: string): Promise<void> {
  await rqlite.executeBatch([
    { sql: "DELETE FROM permission_grants WHERE scope_type = 'server' AND scope_id = ?", params: [serverId] },
    { sql: 'DELETE FROM server_group_members WHERE server_id = ?', params: [serverId] },
  ], { transaction: true });
  invalidatePermissionCache();
}
