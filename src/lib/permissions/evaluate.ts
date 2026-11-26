/**
 * Deciding whether a set of grants allows a permission. Pure: the database
 * lookups that build the inputs live in `store.ts`.
 */
import { impliedSet, permissionDef, permissionsForLevel, satisfiers, type PermissionDef } from './catalog';

export type GrantScope =
  | { type: 'all' }
  | { type: 'server'; id: string }
  | { type: 'server_group'; id: string };

export type GrantEffect = 'allow' | 'deny';

export type ResourceKind = 'stack' | 'container';

/**
 * What a grant can be limited to inside a server: one stack or container, by name, or every one whose name starts
 * with a prefix (`test-*`). A stack limit also covers the containers of that stack.
 */
export interface GrantResource {
  kind: ResourceKind;
  /** An exact name, or a prefix followed by `*`. */
  name: string;
}

export interface Grant {
  permission: string;
  scope: GrantScope;
  /** Missing means allow. A deny beats every allow, from any group or from the access level. */
  effect?: GrantEffect;
  /** Missing: the whole server (every stack and container). */
  resource?: GrantResource;
  /** ISO time after which the grant no longer counts. Missing: never expires. */
  expiresAt?: string;
}

/** The server an action targets, with the server groups it belongs to. */
export interface ServerContext {
  id: string;
  groupIds: readonly string[];
}

/**
 * What an action acts on inside the server: a stack, or a container (with the stack it belongs to, when it has one).
 * `null`/missing: the action is not about one stack or container (pulling an image, pruning): only grants without a
 * resource limit count.
 */
export type ResourceContext =
  | { kind: 'stack'; name: string }
  | { kind: 'container'; name: string; stack?: string | null };

/** A resource name or prefix pattern as stored: letters, digits, `_ . -`, optionally ending in `*`. */
export const RESOURCE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\*?$|^\*$/;

export function nameMatches(pattern: string, name: string | null | undefined): boolean {
  if (!name) return false;
  if (pattern === '*') return true;
  return pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern;
}

function scopeCovers(scope: GrantScope, server: ServerContext | null | undefined): boolean {
  if (scope.type === 'all') return true;
  if (!server) return false;
  if (scope.type === 'server') return scope.id === server.id;
  return server.groupIds.includes(scope.id);
}

/**
 * Does a grant's resource limit cover what the action acts on? No limit covers everything. A limited grant covers
 * only a matching resource: a stack limit covers that stack and its containers, a container limit that container.
 * With `anyResource` (showing controls, not doing anything) a limited grant counts as "somewhere on this server".
 */
export function resourceCovers(limit: GrantResource | undefined, target: ResourceContext | null | undefined, anyResource = false): boolean {
  if (!limit) return true;
  if (anyResource) return true;
  if (!target) return false;
  if (limit.kind === 'stack') return target.kind === 'stack' ? nameMatches(limit.name, target.name) : nameMatches(limit.name, target.stack);
  return target.kind === 'container' && nameMatches(limit.name, target.name);
}

export function grantActive(g: Grant, now = Date.now()): boolean {
  return !g.expiresAt || Date.parse(g.expiresAt) > now;
}

export interface CheckOptions {
  /** What the action acts on inside the server (see ResourceContext). */
  resource?: ResourceContext | null;
  /** Count resource-limited grants anywhere on the server (for showing controls). */
  anyResource?: boolean;
  now?: number;
}

/**
 * Do `grants` allow `permission`, for `server` when it is given? A grant counts when it
 * is the permission itself or one that implies it, its scope covers the server, its resource limit (if any) covers
 * what the action acts on, and it has not expired. Without a server only an all-servers grant counts (global
 * permissions, or "any server").
 */
export function grantsAllow(
  grants: readonly Grant[],
  permission: string,
  server?: ServerContext | null,
  extra: readonly PermissionDef[] = [],
  opts: CheckOptions = {},
): boolean {
  if (!permissionDef(permission, extra)) return false;   // unknown permission: never granted by accident
  const now = opts.now ?? Date.now();
  const live = grants.filter(g => grantActive(g, now));
  // A deny wins over every allow. Denying a permission also denies the ones that include it
  // (denying "check for updates" denies "install updates", which implies it).
  if (denied(live, permission, server, extra, opts)) return false;
  const ok = satisfiers(permission, extra);
  return live.some(g => g.effect !== 'deny' && ok.has(g.permission) && scopeCovers(g.scope, server) && resourceCovers(g.resource, opts.resource, opts.anyResource));
}

/** Does a deny grant cover `permission` for `server` (and the resource)? */
function denied(grants: readonly Grant[], permission: string, server: ServerContext | null | undefined, extra: readonly PermissionDef[], opts: CheckOptions): boolean {
  if (!grants.some(g => g.effect === 'deny')) return false;
  const included = impliedSet(permission, extra);
  return grants.some(g => g.effect === 'deny' && included.has(g.permission) && scopeCovers(g.scope, server)
    // A resource-limited deny only blocks that resource; when showing controls it never hides them for the whole server.
    && (g.resource ? !opts.anyResource && resourceCovers(g.resource, opts.resource) : true));
}

/** Is there any deny grant that could apply to `permission` on some server? */
function mayBeDenied(grants: readonly Grant[], permission: string, extra: readonly PermissionDef[]): boolean {
  if (!grants.some(g => g.effect === 'deny')) return false;
  const included = impliedSet(permission, extra);
  return grants.some(g => g.effect === 'deny' && included.has(g.permission));
}

/**
 * The resource limits under which `grants` allow `permission` on `server`: `'all'` when an unlimited grant allows it
 * (every stack and container), otherwise the list of limits (possibly empty). Used to filter what a principal sees.
 */
export function allowedResources(
  grants: readonly Grant[],
  permission: string,
  server: ServerContext | null,
  extra: readonly PermissionDef[] = [],
  now = Date.now(),
): 'all' | GrantResource[] {
  if (grantsAllow(grants, permission, server, extra, { now })) return 'all';
  const live = grants.filter(g => grantActive(g, now));
  const ok = satisfiers(permission, extra);
  const out: GrantResource[] = [];
  for (const g of live) {
    if (g.effect === 'deny' || !g.resource || !ok.has(g.permission) || !scopeCovers(g.scope, server)) continue;
    // A limit that is itself denied (a matching resource deny) is dropped by the per-row check later.
    out.push(g.resource);
  }
  return out;
}

/**
 * The grants a legacy access level holds on its own: every permission at or below the
 * level, for all servers. (Group grants are added by the caller.)
 */
export function levelGrants(level: string, extra: readonly PermissionDef[] = []): Grant[] {
  return permissionsForLevel(level, extra).map(p => ({ permission: p.id, scope: { type: 'all' } as const }));
}

/**
 * For each server, does the principal hold `permission`? Used by the UI to show or hide
 * buttons. Returns '*' when granted everywhere, otherwise the server ids it is granted on. A grant limited to some
 * stacks or containers counts for its server here; the action itself is checked against the exact target.
 */
export function allowedServerIds(
  grants: readonly Grant[],
  permission: string,
  servers: readonly ServerContext[],
  extra: readonly PermissionDef[] = [],
): '*' | string[] {
  const any = { anyResource: true };
  // "Everywhere" only when nothing is denied anywhere; otherwise decide server by server.
  if (!mayBeDenied(grants, permission, extra) && grantsAllow(grants, permission, null, extra, any)) return '*';
  return servers.filter(s => grantsAllow(grants, permission, s, extra, any)).map(s => s.id);
}
