import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/middleware';
import { ok, failFrom } from '@/lib/api/response';
import { permissionMap } from '@/lib/permissions/authorize';
import { fullCatalog } from '@/lib/permissions/catalog';
import { principalOf } from '@/lib/permissions/effective';
import { loadGroupGrants, registeredPermissionDefs } from '@/lib/permissions/store';
import { allowsResourceLimit } from '@/lib/permissions/validate';
import { visibleServerIds } from '@/lib/permissions/effective';
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';
import { listRequests, requesterOf } from '@/lib/access/requests';
import { MAX_DURATION_HOURS, REQUEST_TTL_HOURS } from '@/lib/access/validate';

export const dynamic = 'force-dynamic';

/**
 * What the caller (an API key or a signed-in user) may do, what it could ask for, and how: GET /api/access.
 * Meant for agents: read this, then POST /api/access-requests for anything missing. Every 403 also names the
 * permission (and the stack/container) that was missing.
 */
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  try {
    const defs = await registeredPermissionDefs();
    const held = await permissionMap(auth);
    const grants = auth.role === 'admin' ? [] : await loadGroupGrants(principalOf(auth)).catch(() => []);
    const visible = await visibleServerIds(auth);
    const servers = rowsToObjects(await rqlite.query('SELECT id, name, platform FROM servers ORDER BY name COLLATE NOCASE'))
      .filter(s => visible === '*' || visible.has(String(s.id)))
      .map(s => ({ id: String(s.id), name: String(s.name), platform: String(s.platform || 'linux') }));
    const requests = await listRequests(auth, { mine: true, limit: 20 });
    return ok({
      principal: { ...requesterOf(auth), level: auth.role },
      // Where each permission is held: '*' (all servers) or server ids. A grant limited to some stacks/containers
      // counts for its server here; the limits are listed under `limited_grants`.
      held,
      limited_grants: grants.filter(g => g.resource || g.expiresAt).map(g => ({
        permission: g.permission, effect: g.effect ?? 'allow', scope: g.scope, resource: g.resource ?? null, expires_at: g.expiresAt ?? null,
      })),
      catalog: fullCatalog(defs).map(d => ({
        id: d.id, label: d.label, description: d.description, group: d.group, risk: d.risk, default_level: d.defaultLevel,
        scope: d.scope, can_limit_to_stack_or_container: allowsResourceLimit(d), held: !!held[d.id],
      })),
      servers,
      requests,
      how_to_request: {
        endpoint: 'POST /api/access-requests',
        status: 'GET /api/access-requests/{id} (pending, approved, denied, expired, cancelled or failed; a one-time action\'s answer is in result)',
        cancel: 'DELETE /api/access-requests/{id}',
        grant: {
          kind: 'grant', permission: '<permission id from catalog>', server_id: servers[0]?.id ?? '<server id>', resource: { kind: 'stack', name: 'test-ai' },
          duration_hours: 8, reason: 'Run integration tests on the test-ai stack',
          notes: `Leave out server_id for all servers, resource for the whole server, duration_hours for a permanent grant (at most ${MAX_DURATION_HOURS}). A resource name may end in * to match by prefix.`,
        },
        one_time: {
          kind: 'one_time', server_id: servers[0]?.id ?? '<server id>', widget_type: '<widget type>', action_id: '<action id>',
          params: { '<parameter>': '<value>' }, reason: 'Create the test stack',
          notes: 'The action runs once, exactly with these parameters, when someone approves it. GET /api/openapi.json lists every action and its parameters.',
        },
        rules: `Requests expire after ${REQUEST_TTL_HOURS} hours if nobody decides. A person who holds the permission decides (Full access for high-risk ones); nobody decides their own request. At most 10 pending per requester.`,
      },
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return failFrom(error);
  }
}
