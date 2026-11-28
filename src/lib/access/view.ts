/** The data behind GET /api/access, shared by the REST route and the MCP access_whoami tool. */
import type { TokenPayload } from '@/lib/auth/jwt';
import { permissionMap } from '@/lib/permissions/authorize';
import { fullCatalog } from '@/lib/permissions/catalog';
import { principalOf, visibleServerIds } from '@/lib/permissions/effective';
import { loadGroupGrants, registeredPermissionDefs } from '@/lib/permissions/store';
import { allowsResourceLimit } from '@/lib/permissions/validate';
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';
import { listRequests, requesterOf } from './requests';
import { MAX_DURATION_HOURS, REQUEST_TTL_HOURS } from './validate';

export async function accessView(auth: TokenPayload) {
  const defs = await registeredPermissionDefs();
  const held = await permissionMap(auth);
  const grants = auth.role === 'admin' ? [] : await loadGroupGrants(principalOf(auth)).catch(() => []);
  const visible = await visibleServerIds(auth);
  const servers = rowsToObjects(await rqlite.query('SELECT id, name, platform FROM servers ORDER BY name COLLATE NOCASE'))
    .filter(s => visible === '*' || visible.has(String(s.id)))
    .map(s => ({ id: String(s.id), name: String(s.name), platform: String(s.platform || 'linux') }));
  const requests = await listRequests(auth, { mine: true, limit: 20 });
  return {
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
      status: 'GET /api/access-requests/{id} (pending, approved, denied, expired, cancelled or failed; decided_by and decision_note say who decided and why; a one-time action\'s answer is in result)',
      wait: 'GET /api/access-requests/{id}?wait=50 holds the call open (up to 50 seconds) until the request is decided, instead of polling; repeat while it is still pending',
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
      command: {
        kind: 'command', server_id: servers[0]?.id ?? '<server id>', command: 'systemctl status nginx', as: 'user',
        reason: 'Check why the site is down',
        notes: 'One command, shown verbatim to the approver, runs once as the non-admin account (as "user") or the privileged service account (as "service").',
      },
      terminal: {
        kind: 'terminal', server_id: servers[0]?.id ?? '<server id>', as: 'user', container: null,
        reason: 'Investigate the deploy by hand',
        notes: 'Approving opens one interactive terminal session for the requester. Pass a container to ask for a shell in it (needs container shell access).',
      },
      rules: `Requests expire after ${REQUEST_TTL_HOURS} hours if nobody decides. A person who holds the permission decides (Full access for high-risk ones); nobody decides their own request. At most 10 pending per requester.`,
    },
  };
}
