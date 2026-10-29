/**
 * What a principal (signed-in user or API key) holds, and which servers it may see.
 * Kept apart from `authorize.ts` so the request middleware can use it without a cycle.
 */
import type { TokenPayload } from '@/lib/auth/jwt';
import type { PermissionDef } from './catalog';
import { allowedServerIds, grantsAllow, levelGrants, type Grant } from './evaluate';
import { allServerContexts, loadGroupGrants, registeredPermissionDefs, serverContext, type Principal } from './store';

export function principalOf(payload: TokenPayload): Principal {
  return payload.authType === 'api_key' && payload.apiKeyId
    ? { kind: 'api_key', id: payload.apiKeyId }
    : { kind: 'user', id: String(payload.userId) };
}

/**
 * Everything a principal holds: its level's default permissions plus its groups' grants. If the
 * group grants cannot be read (database trouble) only the level applies, so failing can never give
 * someone more than they should be able to DO. `strict` throws instead: used where a missing deny
 * would reveal something (which servers exist).
 */
export async function effectiveGrants(payload: TokenPayload, defs?: readonly PermissionDef[], strict = false): Promise<Grant[]> {
  const extra = defs ?? await registeredPermissionDefs();
  const fromLevel = levelGrants(String(payload.role), extra);
  try {
    return [...fromLevel, ...await loadGroupGrants(principalOf(payload))];
  } catch (err) {
    if (strict) throw err;
    console.error('Loading permission groups failed; using the access level only:', err);
    return fromLevel;
  }
}

/** May this principal see `serverId`? Full access always can; everyone else unless a group denies `servers.view` for it. */
export async function serverVisible(payload: TokenPayload, serverId: string): Promise<boolean> {
  if (payload.role === 'admin') return true;
  const extra = await registeredPermissionDefs();
  const server = await serverContext(serverId).catch(() => ({ id: serverId, groupIds: [] as string[] }));
  return grantsAllow(await effectiveGrants(payload, extra, true), 'servers.view', server, extra);
}

/** The servers this principal may see: '*' for all of them, otherwise their ids. */
export async function visibleServerIds(payload: TokenPayload): Promise<'*' | Set<string>> {
  if (payload.role === 'admin') return '*';
  const extra = await registeredPermissionDefs();
  const grants = await effectiveGrants(payload, extra, true);
  const where = allowedServerIds(grants, 'servers.view', await allServerContexts(), extra);
  return where === '*' ? '*' : new Set(where);
}
