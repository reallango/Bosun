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
import { allowedResources, allowedServerIds, grantsAllow, type GrantResource, type ResourceContext, type ServerContext } from './evaluate';
import { allServerContexts, registeredPermissionDefs, serverContext } from './store';
import { effectiveGrants, serverVisible } from './effective';

export { effectiveGrants };

/**
 * Does this principal hold `permission` (for `serverId` when the action targets a server)?
 * A server a principal may not see (a group denies `servers.view` for it) allows nothing on it.
 * Group grants that cannot be read make this throw rather than ignore a deny.
 */
export async function hasPermission(payload: TokenPayload, permission: string, serverId?: string | null, resource?: ResourceContext | null): Promise<boolean> {
  if (payload.role === 'admin') return true;
  const extra = await registeredPermissionDefs();
  const server: ServerContext | null = serverId ? await serverContext(serverId) /* no catch: an unreadable server group must not skip a group-scoped deny */ : null;
  const grants = await effectiveGrants(payload, extra, true);
  if (server && permission !== 'servers.view' && !grantsAllow(grants, 'servers.view', server, extra)) return false;
  return grantsAllow(grants, permission, server, extra, { resource });
}

/**
 * Which stacks/containers of a server a principal may see under `permission`: 'all', a check per stack/container
 * (it holds the permission only for some, or some are denied), or null (none at all). For filtering lists.
 */
export async function resourceFilter(payload: TokenPayload, permission: string, serverId: string): Promise<'all' | ((r: ResourceContext) => boolean) | null> {
  if (payload.role === 'admin') return 'all';
  const extra = await registeredPermissionDefs();
  const server = await serverContext(serverId);
  const grants = await effectiveGrants(payload, extra, true);
  if (!grantsAllow(grants, 'servers.view', server, extra)) return null;
  const check = (r: ResourceContext) => grantsAllow(grants, permission, server, extra, { resource: r });
  if (grantsAllow(grants, permission, server, extra)) return grants.some(g => g.effect === 'deny' && g.resource) ? check : 'all';
  const limits = allowedResources(grants, permission, server, extra);
  return limits === 'all' || limits.length ? check : null;
}

/**
 * The stacks/containers under which a principal holds `permission` on a server: 'all' (no limit) or the list of
 * limits (empty: none).
 */
export async function permittedResources(payload: TokenPayload, permission: string, serverId: string): Promise<'all' | GrantResource[]> {
  if (payload.role === 'admin') return 'all';
  const extra = await registeredPermissionDefs();
  const server = await serverContext(serverId);
  const grants = await effectiveGrants(payload, extra, true);
  if (!grantsAllow(grants, 'servers.view', server, extra)) return [];
  return allowedResources(grants, permission, server, extra);
}

export { serverVisible };

/** Where (which servers) a principal holds each permission: what the UI uses to show or hide controls. */
export async function permissionMap(payload: TokenPayload): Promise<Record<string, '*' | string[]>> {
  const extra = await registeredPermissionDefs();
  const defs = fullCatalog(extra);
  if (payload.role === 'admin') return Object.fromEntries(defs.map(d => [d.id, '*' as const]));
  const grants = await effectiveGrants(payload, extra, true);
  const servers = await allServerContexts();
  const out: Record<string, '*' | string[]> = {};
  for (const d of defs) {
    const where = allowedServerIds(grants, d.id, servers, extra);
    if (where === '*' || where.length) out[d.id] = where;
  }
  return out;
}

/**
 * What to send to POST /api/access-requests to ask for exactly this permission (GET /api/access explains the rest).
 * Shared by the REST 403 body and the MCP tool error, so both give the same hint.
 */
export function permissionRequestBody(permission: string, resource?: ResourceContext | null, serverId?: string | null) {
  return {
    endpoint: 'POST /api/access-requests',
    body: { kind: 'grant', permission, ...(serverId ? { server_id: serverId } : {}), ...(resource ? { resource: { kind: resource.kind, name: resource.name } } : {}), reason: '<why>' },
  };
}

function forbidden(permission: string, label: string, resource?: ResourceContext | null, serverId?: string | null) {
  const on = resource ? ` for the ${resource.kind} "${resource.name}"` : '';
  const request = permissionRequestBody(permission, resource, serverId);
  return NextResponse.json(
    { data: null, error: { message: `Not permitted: requires the "${label}" permission${on}`, code: 'FORBIDDEN', permission, ...(resource ? { resource } : {}), request } },
    { status: 403 },
  );
}

/**
 * Like `requireRole`, for a permission: null when allowed, otherwise the 403 response.
 * Use it when the permission is only known after the request has been read
 * (the action in the body, or a server looked up from a widget).
 */
export async function requirePermission(payload: TokenPayload, permission: string, serverId?: string | null, resource?: ResourceContext | null): Promise<NextResponse | null> {
  if (await hasPermission(payload, permission, serverId, resource)) return null;
  const extra = await registeredPermissionDefs();
  return forbidden(permission, permissionDef(permission, extra)?.label ?? permission, resource, serverId);
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
