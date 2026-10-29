/**
 * Deciding whether a set of grants allows a permission. Pure: the database
 * lookups that build the inputs live in `store.ts`.
 */
import { permissionDef, permissionsForLevel, satisfiers, type PermissionDef } from './catalog';

export type GrantScope =
  | { type: 'all' }
  | { type: 'server'; id: string }
  | { type: 'server_group'; id: string };

export interface Grant {
  permission: string;
  scope: GrantScope;
}

/** The server an action targets, with the server groups it belongs to. */
export interface ServerContext {
  id: string;
  groupIds: readonly string[];
}

function scopeCovers(scope: GrantScope, server: ServerContext | null | undefined): boolean {
  if (scope.type === 'all') return true;
  if (!server) return false;
  if (scope.type === 'server') return scope.id === server.id;
  return server.groupIds.includes(scope.id);
}

/**
 * Do `grants` allow `permission`, for `server` when it is given? A grant counts when it
 * is the permission itself or one that implies it, and its scope covers the server.
 * Without a server only an all-servers grant counts (global permissions, or "any server").
 */
export function grantsAllow(
  grants: readonly Grant[],
  permission: string,
  server?: ServerContext | null,
  extra: readonly PermissionDef[] = [],
): boolean {
  if (!permissionDef(permission, extra)) return false;   // unknown permission: never granted by accident
  const ok = satisfiers(permission, extra);
  return grants.some(g => ok.has(g.permission) && scopeCovers(g.scope, server));
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
 * buttons. Returns '*' when granted everywhere, otherwise the server ids it is granted on.
 */
export function allowedServerIds(
  grants: readonly Grant[],
  permission: string,
  servers: readonly ServerContext[],
  extra: readonly PermissionDef[] = [],
): '*' | string[] {
  if (grantsAllow(grants, permission, null, extra)) return '*';
  return servers.filter(s => grantsAllow(grants, permission, s, extra)).map(s => s.id);
}
