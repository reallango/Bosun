/**
 * `authorize()`: the single guard for actions that can be granted separately.
 *
 *   const auth = await authorize(request, 'power.restart', { serverId });
 *   if (auth instanceof NextResponse) return auth;
 *
 * A principal (signed-in user or API key) may do something when
 *  - it has Full access (admin level), which holds every permission, or
 *  - its access level grants it by default (Read + actions holds the operator
 *    permissions, exactly as before), or
 *  - one of its permission groups grants it for that server (or for all servers).
 *
 * Reading is not gated here: every principal has at least Read only access.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireUserSession } from '@/lib/auth/middleware';
import type { TokenPayload } from '@/lib/auth/jwt';
import { fullCatalog, permissionDef, type PermissionDef } from './catalog';
import { allowedServerIds, grantsAllow, levelGrants, type Grant, type ServerContext } from './evaluate';
import { allServerContexts, loadGroupGrants, registeredPermissionDefs, serverContext, type Principal } from './store';

function principalOf(payload: TokenPayload): Principal {
  return payload.authType === 'api_key' && payload.apiKeyId
    ? { kind: 'api_key', id: payload.apiKeyId }
    : { kind: 'user', id: String(payload.userId) };
}

/**
 * Everything a principal holds: its level's default permissions plus its groups' grants. If the
 * group grants cannot be read (database trouble) only the level applies: failing to the base
 * level can never give someone more than they should have.
 */
export async function effectiveGrants(payload: TokenPayload, defs?: readonly PermissionDef[]): Promise<Grant[]> {
  const extra = defs ?? await registeredPermissionDefs();
  const fromLevel = levelGrants(String(payload.role), extra);
  try {
    return [...fromLevel, ...await loadGroupGrants(principalOf(payload))];
  } catch (err) {
    console.error('Loading permission groups failed; using the access level only:', err);
    return fromLevel;
  }
}

/** Does this principal hold `permission` (for `serverId` when the action targets a server)? */
export async function hasPermission(payload: TokenPayload, permission: string, serverId?: string | null): Promise<boolean> {
  if (payload.role === 'admin') return true;
  const extra = await registeredPermissionDefs();
  const server: ServerContext | null = serverId ? await serverContext(serverId).catch(() => ({ id: serverId, groupIds: [] })) : null;
  return grantsAllow(await effectiveGrants(payload, extra), permission, server, extra);
}

/** Where (which servers) a principal holds each permission: what the UI uses to show or hide controls. */
export async function permissionMap(payload: TokenPayload): Promise<Record<string, '*' | string[]>> {
  const extra = await registeredPermissionDefs();
  const defs = fullCatalog(extra);
  if (payload.role === 'admin') return Object.fromEntries(defs.map(d => [d.id, '*' as const]));
  const grants = await effectiveGrants(payload, extra);
  const servers = await allServerContexts().catch(() => [] as ServerContext[]);
  const out: Record<string, '*' | string[]> = {};
  for (const d of defs) {
    const where = allowedServerIds(grants, d.id, servers, extra);
    if (where === '*' || where.length) out[d.id] = where;
  }
  return out;
}

function forbidden(permission: string, label: string) {
  return NextResponse.json(
    { data: null, error: { message: `Not permitted: requires the "${label}" permission`, code: 'FORBIDDEN', permission } },
    { status: 403 },
  );
}

/**
 * Like `requireRole`, for a permission: null when allowed, otherwise the 403 response.
 * Use it when the permission is only known after the request has been read
 * (the action in the body, or a server looked up from a widget).
 */
export async function requirePermission(payload: TokenPayload, permission: string, serverId?: string | null): Promise<NextResponse | null> {
  if (await hasPermission(payload, permission, serverId)) return null;
  const extra = await registeredPermissionDefs();
  return forbidden(permission, permissionDef(permission, extra)?.label ?? permission);
}

/**
 * Authenticate the request and require `permission`. Pass `serverId` for actions on a
 * host so server-scoped grants are honoured; `userSession` refuses API keys.
 * Returns the token payload, or the error response to return.
 */
export async function authorize(
  request: NextRequest,
  permission: string,
  opts: { serverId?: string | null; userSession?: boolean } = {},
): Promise<TokenPayload | NextResponse> {
  const auth = opts.userSession ? await requireUserSession(request) : await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  return (await requirePermission(auth, permission, opts.serverId)) ?? auth;
}
