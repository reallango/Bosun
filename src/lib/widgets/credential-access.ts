/**
 * Shared access checks for the credential API.
 *
 * Reading (public fields, whether each secret is set) needs the kind's `viewPermission` — never `kind.permission`,
 * which is the permission that changes an entry — and only for the servers the caller may see: the list holds the
 * entries whose servers the caller may view, so an entry scoped to a server it may not see (or may not view) stays
 * invisible. A grant limited to some stacks or containers counts for viewing: that shows the widget rather than acting
 * on a container.
 *
 * Creating, editing and deleting needs the kind's own permission on every server the entry applies to (or on every
 * visible server when it applies to all of them).
 */
import { NextResponse } from 'next/server';
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';
import { getInstalledPackage } from '@/lib/widgets/package-store';
import { hasPermission, requirePermission } from '@/lib/permissions/authorize';
import { effectiveGrants, visibleServerIds } from '@/lib/permissions/effective';
import { grantsAllow } from '@/lib/permissions/evaluate';
import { allServerContexts, registeredPermissionDefs } from '@/lib/permissions/store';
import type { TokenPayload } from '@/lib/auth/jwt';
import type { CredentialKindDef } from './credentials-schema';

export interface KindContext {
  packageId: string;
  kind: CredentialKindDef;
  kinds: CredentialKindDef[];
}

/** Every credential kind of the package behind a widget type (null when the type is not a package widget). */
export async function kindsForType(type: string): Promise<{ packageId: string; kinds: CredentialKindDef[] } | null> {
  const row = rowsToObjects(await rqlite.query('SELECT package_id FROM custom_widgets WHERE type = ? AND package_id IS NOT NULL', [type]))[0];
  if (!row) return null;
  const found = await getInstalledPackage(String(row.package_id));
  return found ? { packageId: found.pkg.id, kinds: found.pkg.manifest.credentials } : null;
}

/** The package behind a widget type, and one of the credential kinds it declares. */
export async function kindForType(type: string, kindId: string): Promise<KindContext | null> {
  const found = await kindsForType(type);
  if (!found) return null;
  const kind = found.kinds.find(k => k.id === kindId);
  return kind ? { packageId: found.packageId, kind, kinds: found.kinds } : null;
}

async function visibleServers(auth: TokenPayload) {
  const visible = await visibleServerIds(auth);
  return (await allServerContexts()).filter(s => visible === '*' || visible.has(s.id));
}

/**
 * The servers the caller may read this kind's credentials on: the ones it can see where it holds the kind's
 * `viewPermission`. Empty when it may read none.
 */
export async function viewTargets(auth: TokenPayload, kind: CredentialKindDef): Promise<string[]> {
  const servers = await visibleServers(auth);
  if (auth.role === 'admin') return servers.map(s => s.id);
  const extra = await registeredPermissionDefs();
  const grants = await effectiveGrants(auth, extra, true);
  return servers.filter(s => grantsAllow(grants, kind.viewPermission, s, extra, { anyResource: true })).map(s => s.id);
}

export async function canViewKind(auth: TokenPayload, kind: CredentialKindDef): Promise<boolean> {
  return (await viewTargets(auth, kind)).length > 0;
}

/**
 * Is entry `servers` one the caller may list? An entry scoped to servers must be viewable on every one of them (it
 * would otherwise name servers the caller cannot see); one that applies to every server is viewable when the caller
 * may view the kind anywhere.
 */
export function entryViewable(servers: readonly string[], viewIds: readonly string[]): boolean {
  if (!viewIds.length) return false;
  return servers.length ? servers.every(id => viewIds.includes(id)) : true;
}

export async function canManageKind(auth: TokenPayload, kind: CredentialKindDef): Promise<boolean> {
  if (auth.role === 'admin') return true;
  for (const server of await visibleServers(auth)) {
    if (await hasPermission(auth, kind.permission, server.id)) return true;
  }
  return false;
}

/** null when allowed, otherwise the 403 to return (with the access-request hint). */
export async function requireKindManage(auth: TokenPayload, kind: CredentialKindDef, servers: string[]): Promise<NextResponse | null> {
  if (auth.role === 'admin') return null;
  const targets = servers.length ? servers : (await visibleServers(auth)).map(s => s.id);
  for (const serverId of targets) {
    const denied = await requirePermission(auth, kind.permission, serverId);
    if (denied) return denied;
  }
  return null;
}

/**
 * The servers an edit must be allowed on: what the entry is scoped to now plus what it will be scoped to. `next` is
 * null when the scope is left alone. An empty list means "every server", so it is passed on as such: widening an
 * entry from one server to all of them needs the permission everywhere, not only where it happened to be before.
 */
export function manageTargets(existing: string[], next: string[] | null): string[] {
  if (next === null) return existing;
  if (!next.length) return [];
  return Array.from(new Set([...existing, ...next]));
}

/** The kind as the UI (and MCP) may see it: no migration rules, no secrets. */
export function publicKind(kind: CredentialKindDef) {
  return {
    id: kind.id, label: kind.label, permission: kind.permission, viewPermission: kind.viewPermission,
    fields: kind.fields, ...(kind.match ? { match: kind.match } : {}),
    servers: kind.servers, defaultPerServer: kind.defaultPerServer,
  };
}

export async function serverChoices(auth: TokenPayload): Promise<{ id: string; name: string }[]> {
  const visible = await visibleServerIds(auth);
  const r = await rqlite.query('SELECT id, name FROM servers ORDER BY name');
  return rowsToObjects(r)
    .filter(s => visible === '*' || visible.has(String(s.id)))
    .map(s => ({ id: String(s.id), name: String(s.name) }));
}
