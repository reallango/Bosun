/**
 * Validation of permission-group and server-group input from the API. Pure.
 */
import { permissionDef, type PermissionDef } from './catalog';
import type { Grant } from './evaluate';

export const MAX_NAME = 60;
export const MAX_DESCRIPTION = 300;
export const MAX_GRANTS = 500;
export const MAX_MEMBERS = 2000;
export const MAX_GROUP_IDS = 50;

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export interface GroupInput {
  name?: string;
  description?: string | null;
  /** When present it replaces all of the group's grants. */
  grants?: Grant[];
}

export interface ServerGroupInput {
  name?: string;
  description?: string | null;
  /** When present it replaces the group's members. */
  server_ids?: string[];
}

export const grantKey = (g: Grant) => `${g.permission}|${g.scope.type}|${g.scope.type === 'all' ? '' : g.scope.id}`;

function str(v: unknown): string | null {
  return typeof v === 'string' ? v.trim() : null;
}

function nameAndDescription(body: Record<string, unknown>, creating: boolean): Result<{ name?: string; description?: string | null }> {
  const out: { name?: string; description?: string | null } = {};
  if (body.name !== undefined || creating) {
    const name = str(body.name);
    if (!name) return { ok: false, error: 'A name is required' };
    if (name.length > MAX_NAME) return { ok: false, error: `The name can be at most ${MAX_NAME} characters` };
    out.name = name;
  }
  if (body.description !== undefined) {
    if (body.description === null || body.description === '') out.description = null;
    else {
      const d = str(body.description);
      if (d === null) return { ok: false, error: 'The description must be text' };
      if (d.length > MAX_DESCRIPTION) return { ok: false, error: `The description can be at most ${MAX_DESCRIPTION} characters` };
      out.description = d;
    }
  }
  return { ok: true, value: out };
}

/** Normalise the grants of a permission group: known permissions only, scopes that make sense, no duplicates. */
export function validateGrants(raw: unknown, defs: readonly PermissionDef[] = []): Result<Grant[]> {
  if (!Array.isArray(raw)) return { ok: false, error: 'grants must be a list' };
  if (raw.length > MAX_GRANTS) return { ok: false, error: `A group can have at most ${MAX_GRANTS} grants` };
  const seen = new Set<string>();
  const out: Grant[] = [];
  for (const item of raw) {
    const permission = item && typeof item === 'object' ? str((item as Record<string, unknown>).permission) : null;
    if (!permission) return { ok: false, error: 'Every grant needs a permission' };
    const def = permissionDef(permission, defs);
    if (!def) return { ok: false, error: `Unknown permission "${permission}"` };
    const scope = (item as Record<string, unknown>).scope as Record<string, unknown> | undefined;
    const type = scope && typeof scope === 'object' ? scope.type : 'all';
    let grant: Grant;
    if (type === 'all' || type === undefined) {
      grant = { permission, scope: { type: 'all' } };
    } else if (type === 'server' || type === 'server_group') {
      const id = str(scope?.id);
      if (!id || id.length > 64) return { ok: false, error: `The "${def.label}" grant needs a ${type === 'server' ? 'server' : 'server group'}` };
      if (def.scope === 'global') return { ok: false, error: `"${def.label}" is not tied to a server, so it can only be granted for everything` };
      grant = { permission, scope: { type, id } };
    } else {
      return { ok: false, error: `Unknown scope "${String(type)}"` };
    }
    const rawEffect = (item as Record<string, unknown>).effect;
    if (rawEffect !== undefined && rawEffect !== 'allow' && rawEffect !== 'deny') return { ok: false, error: 'Each grant must be either allow or deny' };
    if (rawEffect === 'deny') grant.effect = 'deny';
    const key = grantKey(grant);
    const earlier = out.find(o => grantKey(o) === key);
    if (earlier && (earlier.effect ?? 'allow') !== (grant.effect ?? 'allow')) {
      return { ok: false, error: `"${def.label}" is both allowed and denied for the same servers` };
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(grant);
  }
  return { ok: true, value: out };
}

/** Body of POST/PATCH /api/permission-groups. */
export function validateGroupInput(body: unknown, defs: readonly PermissionDef[], creating: boolean): Result<GroupInput> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'Invalid request body' };
  const b = body as Record<string, unknown>;
  const nd = nameAndDescription(b, creating);
  if (!nd.ok) return nd;
  const value: GroupInput = { ...nd.value };
  if (b.grants !== undefined) {
    const g = validateGrants(b.grants, defs);
    if (!g.ok) return g;
    value.grants = g.value;
  } else if (creating) {
    value.grants = [];
  }
  return { ok: true, value };
}

/** Body of POST/PATCH /api/server-groups. */
export function validateServerGroupInput(body: unknown, creating: boolean): Result<ServerGroupInput> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'Invalid request body' };
  const b = body as Record<string, unknown>;
  const nd = nameAndDescription(b, creating);
  if (!nd.ok) return nd;
  const value: ServerGroupInput = { ...nd.value };
  if (b.server_ids !== undefined) {
    if (!Array.isArray(b.server_ids) || b.server_ids.some(s => typeof s !== 'string' || !s || s.length > 64)) {
      return { ok: false, error: 'server_ids must be a list of server ids' };
    }
    if (b.server_ids.length > MAX_MEMBERS) return { ok: false, error: `A server group can have at most ${MAX_MEMBERS} servers` };
    value.server_ids = Array.from(new Set(b.server_ids as string[]));
  } else if (creating) {
    value.server_ids = [];
  }
  return { ok: true, value };
}

/** A list of permission group ids to assign to a user or API key. */
export function validateGroupIds(raw: unknown): Result<string[]> {
  if (!Array.isArray(raw) || raw.some(s => typeof s !== 'string' || !s || s.length > 64)) return { ok: false, error: 'group_ids must be a list of group ids' };
  if (raw.length > MAX_GROUP_IDS) return { ok: false, error: `At most ${MAX_GROUP_IDS} groups can be assigned` };
  return { ok: true, value: Array.from(new Set(raw as string[])) };
}
