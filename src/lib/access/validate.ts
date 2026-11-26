/**
 * Validation of access request input. Pure (no database): the caller supplies the permission definitions.
 *
 * Two kinds:
 *  - grant: { kind: 'grant', permission, server_id?, resource?: { kind, name }, duration_hours?, reason? }
 *    A permission for one server (or all), optionally limited to a stack/container, for some hours or (no
 *    duration_hours) until someone removes it.
 *  - one_time: { kind: 'one_time', server_id, widget_type, action_id, params?, reason? }
 *    One widget action run once, exactly as sent, when approved.
 */
import { permissionDef, type PermissionDef } from '@/lib/permissions/catalog';
import { RESOURCE_NAME_RE, type GrantResource } from '@/lib/permissions/evaluate';
import { allowsResourceLimit } from '@/lib/permissions/validate';

export const MAX_DURATION_HOURS = 24 * 366;
export const MAX_REASON = 500;
export const MAX_PARAMS_BYTES = 70_000;
export const REQUEST_TTL_HOURS = 24;
export const MAX_PENDING_PER_REQUESTER = 10;

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const WIDGET = /^[a-z0-9_]{1,64}$/;

export type GrantRequestInput = {
  kind: 'grant'; permission: string; serverId: string | null; resource: GrantResource | null; durationHours: number | null; reason: string | null;
};
export type OneTimeRequestInput = {
  kind: 'one_time'; serverId: string; widgetType: string; actionId: string; params: Record<string, unknown>; reason: string | null;
};
export type RequestInput = GrantRequestInput | OneTimeRequestInput;

type R<T> = { ok: true; value: T } | { ok: false; error: string };

function reasonOf(v: unknown): R<string | null> {
  if (v === undefined || v === null || v === '') return { ok: true, value: null };
  if (typeof v !== 'string') return { ok: false, error: 'reason must be text' };
  const s = v.trim();
  if (s.length > MAX_REASON) return { ok: false, error: `reason can be at most ${MAX_REASON} characters` };
  return { ok: true, value: s || null };
}

export function validateRequestInput(body: unknown, defs: readonly PermissionDef[]): R<RequestInput> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'Invalid request body' };
  const b = body as Record<string, unknown>;
  const reason = reasonOf(b.reason);
  if (!reason.ok) return reason;
  const serverId = b.server_id === undefined || b.server_id === null || b.server_id === '' ? null : b.server_id;
  if (serverId !== null && (typeof serverId !== 'string' || !ID.test(serverId))) return { ok: false, error: 'server_id must be a server id' };

  if (b.kind === 'grant') {
    if (typeof b.permission !== 'string') return { ok: false, error: 'permission is required' };
    const def = permissionDef(b.permission, defs);
    if (!def) return { ok: false, error: `Unknown permission "${b.permission}" (GET /api/access lists them)` };
    if (def.scope === 'global' && serverId) return { ok: false, error: `"${def.label}" is not tied to a server: leave server_id out` };
    let resource: GrantResource | null = null;
    if (b.resource !== undefined && b.resource !== null) {
      const r = b.resource as Record<string, unknown>;
      if (typeof b.resource !== 'object' || (r.kind !== 'stack' && r.kind !== 'container') || typeof r.name !== 'string' || !RESOURCE_NAME_RE.test(r.name)) {
        return { ok: false, error: 'resource must be { kind: "stack" | "container", name } (a name, or a prefix ending in *)' };
      }
      if (!allowsResourceLimit(def)) return { ok: false, error: `"${def.label}" cannot be limited to a stack or container` };
      if (!serverId) return { ok: false, error: 'A request limited to a stack or container needs server_id' };
      resource = { kind: r.kind, name: r.name };
    }
    let durationHours: number | null = null;
    if (b.duration_hours !== undefined && b.duration_hours !== null) {
      const h = Number(b.duration_hours);
      if (!Number.isInteger(h) || h < 1 || h > MAX_DURATION_HOURS) return { ok: false, error: `duration_hours must be a whole number of hours, 1 to ${MAX_DURATION_HOURS} (leave it out for a permanent grant)` };
      durationHours = h;
    }
    return { ok: true, value: { kind: 'grant', permission: def.id, serverId, resource, durationHours, reason: reason.value } };
  }

  if (b.kind === 'one_time') {
    if (!serverId) return { ok: false, error: 'A one-time action needs server_id' };
    if (typeof b.widget_type !== 'string' || !WIDGET.test(b.widget_type)) return { ok: false, error: 'widget_type is required (e.g. docker_containers)' };
    if (typeof b.action_id !== 'string' || !WIDGET.test(b.action_id)) return { ok: false, error: 'action_id is required (e.g. stack_deploy)' };
    const params = b.params === undefined || b.params === null ? {} : b.params;
    if (typeof params !== 'object' || Array.isArray(params)) return { ok: false, error: 'params must be an object' };
    if (JSON.stringify(params).length > MAX_PARAMS_BYTES) return { ok: false, error: 'params are too large' };
    return { ok: true, value: { kind: 'one_time', serverId, widgetType: b.widget_type, actionId: b.action_id, params: params as Record<string, unknown>, reason: reason.value } };
  }
  return { ok: false, error: 'kind must be "grant" or "one_time"' };
}

/** Who may see a request in the bell: Full access for high-risk or admin-level permissions, otherwise Read + actions and up. */
export function audienceFor(def: PermissionDef): 'admin' | 'operator' {
  return def.risk === 'high' || def.defaultLevel === 'admin' ? 'admin' : 'operator';
}

/** A one-line description of what is asked, for the bell and the audit log. */
export function describeRequest(r: {
  kind: string; permissionLabel: string; serverName: string | null; resource: GrantResource | null; durationHours: number | null; actionLabel?: string | null;
}): string {
  const where = r.serverName ? ` on ${r.serverName}` : ' on all servers';
  const limit = r.resource ? ` (${r.resource.kind} ${r.resource.name})` : '';
  if (r.kind === 'one_time') return `run "${r.actionLabel ?? r.permissionLabel}" once${where}${limit}`;
  const how = r.durationHours ? ` for ${r.durationHours} hour${r.durationHours === 1 ? '' : 's'}` : ' permanently';
  return `"${r.permissionLabel}"${where}${limit}${how}`;
}
