/**
 * Access requests: an API key or user asks for more than it holds, and someone who holds it decides.
 *
 *  - grant: approved grants go into a permission group kept for that requester ("Approved requests: <name>"),
 *    with an expiry when the request was for some hours. Removing it later is ordinary group editing.
 *  - one_time: the widget action is run once, exactly as it was requested (the parameters were frozen when the
 *    request was made), as the requester, so its job and audit entry name them; the approver is recorded too.
 *
 * Rules: an approver must be a signed-in person (not an API key), must not be the requester, must hold the
 * permission for that server (and stack/container), and high-risk or Full-access-only permissions need Full access.
 * Requests expire after 24 hours; each requester may have at most 10 pending.
 */
import crypto from 'crypto';
import type { TokenPayload } from '@/lib/auth/jwt';
import { hasRole } from '@/lib/auth/levels';
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';
import { logAudit } from '@/lib/audit/logger';
import { hasPermission } from '@/lib/permissions/authorize';
import { permissionDef, type PermissionDef } from '@/lib/permissions/catalog';
import type { GrantResource, ResourceContext } from '@/lib/permissions/evaluate';
import { serverVisible } from '@/lib/permissions/effective';
import { invalidatePermissionCache, registeredPermissionDefs } from '@/lib/permissions/store';
import { notify, resolveByKeyPrefix } from '@/lib/notifications/store';
import { redactParams } from '@/lib/widgets/jobs/store';
import { audienceFor, describeRequest, MAX_PENDING_PER_REQUESTER, REQUEST_TTL_HOURS, type RequestInput } from './validate';
import { requesterPayload } from './requester';
import { CONTAINER_SHELL_PERMISSION } from '@/lib/exec/container-permission';
import { elevatedHint } from '@/lib/widgets/runtime/elevated';

export class RequestError extends Error {
  constructor(message: string, readonly status = 400, readonly code = 'INVALID_REQUEST') { super(message); }
}

export interface Requester { type: 'user' | 'api_key'; id: string; name: string }

export function requesterOf(auth: TokenPayload): Requester {
  return auth.authType === 'api_key' && auth.apiKeyId
    ? { type: 'api_key', id: auth.apiKeyId, name: auth.username }
    : { type: 'user', id: String(auth.userId), name: auth.username };
}

export interface AccessRequestDto {
  id: string;
  kind: 'grant' | 'one_time' | 'command' | 'terminal';
  status: string;
  requester: Requester;
  permission: string;
  permission_label: string;
  risk: string;
  server_id: string | null;
  server_name: string | null;
  resource: GrantResource | null;
  duration_hours: number | null;
  /** one_time: what will run (parameters with text and secret-looking values masked). */
  action: { widget_type: string; action_id: string; label: string; params: Record<string, unknown> } | null;
  /** command/terminal: the exact command (verbatim) or terminal account, shown to the approver. */
  command: { command: string; as: 'user' | 'service'; container: string | null } | null;
  reason: string | null;
  summary: string;
  created_at: string;
  expires_at: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  /** grant: { expires_at } ; one_time: the action's answer ({ jobId } for a job, or its output). */
  result: unknown;
}

const nowIso = () => new Date().toISOString();

async function serverName(id: string | null): Promise<string | null> {
  if (!id) return null;
  const r = await rqlite.query('SELECT name FROM servers WHERE id = ?', [id]);
  return r.values?.[0]?.[0] ? String(r.values[0][0]) : null;
}

function parse<T>(s: unknown, fallback: T): T {
  if (typeof s !== 'string' || !s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

type StoredAction = {
  widgetType?: string; actionId?: string; label?: string; params?: Record<string, unknown>;
  command?: string; as?: 'user' | 'service'; container?: string | null;
};

async function toDto(row: Record<string, unknown>, defs: readonly PermissionDef[], names: Map<string, string>): Promise<AccessRequestDto> {
  const def = permissionDef(String(row.permission), defs);
  const resource = row.resource_kind ? { kind: row.resource_kind as GrantResource['kind'], name: String(row.resource_name) } : null;
  const stored = parse<StoredAction | null>(row.action, null);
  const kind = String(row.kind);
  const command = kind === 'command' || kind === 'terminal'
    ? { command: stored?.command ?? '', as: stored?.as === 'service' ? 'service' as const : 'user' as const, container: stored?.container ?? null }
    : null;
  const action = kind === 'one_time' && stored?.widgetType && stored.actionId
    ? { widgetType: stored.widgetType, actionId: stored.actionId, label: stored.label, params: stored.params }
    : null;
  const sid = row.server_id ? String(row.server_id) : null;
  const sname = sid ? names.get(sid) ?? null : null;
  const durationHours = row.duration_hours === null || row.duration_hours === undefined ? null : Number(row.duration_hours);
  return {
    id: String(row.id), kind: kind as AccessRequestDto['kind'], status: String(row.status),
    requester: { type: row.requester_type as Requester['type'], id: String(row.requester_id), name: String(row.requester_name) },
    permission: String(row.permission), permission_label: def?.label ?? String(row.permission), risk: def?.risk ?? 'high',
    server_id: sid, server_name: sname, resource, duration_hours: durationHours,
    action: action ? { widget_type: action.widgetType, action_id: action.actionId, label: action.label ?? action.actionId, params: redactParams(action.params ?? {}) } : null,
    command,
    reason: row.reason ? String(row.reason) : null,
    summary: describeRequest({
      kind, permissionLabel: def?.label ?? String(row.permission), serverName: sid ? (sname ?? 'a server') : null, resource, durationHours,
      actionLabel: action?.label, command: command?.command, commandAs: command?.as, container: command?.container,
    }),
    created_at: String(row.created_at), expires_at: String(row.expires_at),
    decided_by: row.decided_by_name ? String(row.decided_by_name) : null, decided_at: row.decided_at ? String(row.decided_at) : null,
    decision_note: row.decision_note ? String(row.decision_note) : null,
    result: parse(row.result, null),
  };
}

async function serverNames(): Promise<Map<string, string>> {
  return new Map(rowsToObjects(await rqlite.query('SELECT id, name FROM servers')).map(r => [String(r.id), String(r.name)]));
}

/** Pending requests older than 24 hours become `expired` (and leave the bell). */
export async function expireStale(): Promise<void> {
  const stale = await rqlite.query("SELECT id FROM access_requests WHERE status = 'pending' AND expires_at < ?", [nowIso()]);
  for (const [id] of stale.values || []) {
    const r = await rqlite.execute("UPDATE access_requests SET status = 'expired' WHERE id = ? AND status = 'pending'", [String(id)]);
    if (r.rows_affected === 1) await resolveByKeyPrefix(`access-request:${id}`);
  }
}

/** What a resource limit means as one target, for "does someone already hold this" (a prefix is not one target). */
function contextOf(r: GrantResource | null): ResourceContext | null {
  if (!r || r.name.endsWith('*')) return null;
  return r.kind === 'stack' ? { kind: 'stack', name: r.name } : { kind: 'container', name: r.name, stack: null };
}

export async function createRequest(auth: TokenPayload, input: RequestInput): Promise<AccessRequestDto> {
  await expireStale();
  const who = requesterOf(auth);
  const defs = await registeredPermissionDefs();
  if (input.serverId) {
    const exists = await rqlite.query('SELECT 1 FROM servers WHERE id = ?', [input.serverId]);
    if (!exists.values?.length || !(await serverVisible(auth, input.serverId))) throw new RequestError('Server not found', 404, 'NOT_FOUND');
  }
  const pending = await rqlite.query("SELECT COUNT(*) FROM access_requests WHERE requester_type = ? AND requester_id = ? AND status = 'pending'", [who.type, who.id]);
  if (Number(pending.values?.[0]?.[0] ?? 0) >= MAX_PENDING_PER_REQUESTER) {
    throw new RequestError(`You already have ${MAX_PENDING_PER_REQUESTER} pending requests; wait for a decision or cancel one`, 429, 'TOO_MANY_REQUESTS');
  }

  let permission: string;
  let resource: GrantResource | null = null;
  let action: string | null = null;
  let actionLabel: string | null = null;
  let commandText: string | null = null;
  let commandAs: 'user' | 'service' | null = null;
  let container: string | null = null;
  if (input.kind === 'grant') {
    permission = input.permission;
    resource = input.resource;
    const ctx = contextOf(resource);
    if ((!resource || ctx) && await hasPermission(auth, permission, input.serverId, ctx)) {
      throw new RequestError('You already hold this permission there', 409, 'ALREADY_GRANTED');
    }
  } else if (input.kind === 'command') {
    permission = input.as === 'user' ? 'shell.user' : 'exec.service';
    commandText = input.command;
    commandAs = input.as;
    action = JSON.stringify({ command: input.command, as: input.as });
    if (await hasPermission(auth, permission, input.serverId)) {
      throw new RequestError('You already hold this permission there: run the command directly', 409, 'ALREADY_GRANTED');
    }
  } else if (input.kind === 'terminal') {
    container = input.container;
    permission = container ? CONTAINER_SHELL_PERMISSION : input.as === 'user' ? 'shell.user' : 'exec.service';
    commandAs = container ? 'service' : input.as;
    resource = container ? { kind: 'container', name: container } : null;
    action = JSON.stringify({ as: commandAs, container });
    if (await hasPermission(auth, permission, input.serverId, container ? { kind: 'container', name: container } : null)) {
      throw new RequestError('You already hold this permission there: open the terminal directly', 409, 'ALREADY_GRANTED');
    }
  } else {
    const { loadWidgetSpec } = await import('@/lib/widgets/runtime/execute');
    const loaded = await loadWidgetSpec(input.widgetType);
    if (!loaded) {
      const { widgetTypeApiProblem } = await import('@/lib/widgets/package-api-level');
      const newer = await widgetTypeApiProblem(input.widgetType).catch(() => null);
      if (newer) throw new RequestError(newer, 422, 'NEWER_BOSUN_REQUIRED');
    }
    const a = loaded?.spec.actions.find(x => x.id === input.actionId);
    if (!loaded || !a) throw new RequestError('Unknown widget action (GET /api/openapi.json lists them)', 404, 'NOT_FOUND');
    if (a.kind !== 'script' && a.kind !== 'command') throw new RequestError('Only actions that run a command or script can be requested once (not screens or terminals)', 400, 'NOT_RUNNABLE');
    permission = a.permission;
    actionLabel = a.label;
    let ctx: ResourceContext | null = null;
    if (a.target) {
      const { resolveTarget, TargetError } = await import('@/lib/widgets/runtime/resource-check');
      try { ctx = await resolveTarget(input.serverId, loaded, a.target, input.params[a.target.param], 'byKind' in a.target ? (input.params[a.target.byKind] ?? a.params[a.target.byKind]?.default) : undefined); } catch (e) {
        if (e instanceof TargetError) throw new RequestError(e.message, e.status, e.code);
        throw e;
      }
      resource = { kind: ctx.kind, name: ctx.name };
    }
    if (await hasPermission(auth, permission, input.serverId, ctx)) {
      const hint = elevatedHint(a, loaded.spec.actions, id => permissionDef(id, defs)?.label ?? id);
      throw new RequestError(`You already hold this permission there: run the action directly.${hint}`, 409, 'ALREADY_GRANTED');
    }
    action = JSON.stringify({ widgetType: input.widgetType, actionId: input.actionId, label: a.label, params: input.params });
  }

  const def = permissionDef(permission, defs)!;
  const id = crypto.randomUUID();
  const created = nowIso();
  const expires = new Date(Date.now() + REQUEST_TTL_HOURS * 3600_000).toISOString();
  await rqlite.execute(
    `INSERT INTO access_requests (id, requester_type, requester_id, requester_name, kind, permission, server_id, resource_kind, resource_name, duration_hours, action, reason, status, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    [id, who.type, who.id, who.name, input.kind, permission, input.serverId, resource?.kind ?? '', resource?.name ?? '',
      input.kind === 'grant' ? input.durationHours : null, action, input.reason, created, expires]);
  const names = await serverNames();
  const summary = describeRequest({
    kind: input.kind, permissionLabel: def.label, serverName: input.serverId ? names.get(input.serverId) ?? 'a server' : null,
    resource, durationHours: input.kind === 'grant' ? input.durationHours : null, actionLabel,
    command: commandText, commandAs, container,
  });
  await notify({
    kind: 'access_request', severity: def.risk === 'high' ? 'critical' : 'warning',
    title: `${who.name}${who.type === 'api_key' ? ' (API key)' : ''} asks for access`,
    message: `${who.name} asks to ${input.kind === 'grant' ? `get ${summary}` : summary}.${commandAs === 'service' ? ' This runs as the privileged service account.' : ''}${input.reason ? ` Reason: ${input.reason}` : ''}`,
    link: `/settings/access-requests?id=${id}`, dedupeKey: `access-request:${id}`, audience: audienceFor(def),
    serverId: input.serverId, data: { requestId: id },
  });
  await logAudit({ userId: auth.userId, action: 'access.request', category: 'access', status: 'success', details: JSON.stringify({ id, kind: input.kind, summary }).slice(0, 900) }).catch(() => undefined);
  const row = rowsToObjects(await rqlite.query('SELECT * FROM access_requests WHERE id = ?', [id]))[0];
  return toDto(row, defs, names);
}

/** Requests a viewer may see: their own, plus (for people who can decide) everyone's. */
export async function listRequests(viewer: TokenPayload, opts: { mine?: boolean; status?: string; limit?: number } = {}): Promise<AccessRequestDto[]> {
  await expireStale();
  const who = requesterOf(viewer);
  const decider = viewer.authType !== 'api_key' && hasRole(viewer.role, 'operator');
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.mine || !decider) { where.push('requester_type = ? AND requester_id = ?'); params.push(who.type, who.id); }
  if (opts.status) { where.push('status = ?'); params.push(opts.status); }
  const rows = rowsToObjects(await rqlite.query(
    `SELECT * FROM access_requests ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`,
    [...params, Math.min(Math.max(opts.limit ?? 100, 1), 500)]));
  const defs = await registeredPermissionDefs();
  const names = await serverNames();
  const out: AccessRequestDto[] = [];
  for (const row of rows) {
    const mine = row.requester_type === who.type && row.requester_id === who.id;
    // Someone else's request: only if this viewer could see its server (and so might decide it).
    if (!mine && row.server_id && !(await serverVisible(viewer, String(row.server_id)))) continue;
    out.push(await toDto(row, defs, names));
  }
  return out;
}

export async function getRequest(viewer: TokenPayload, id: string): Promise<AccessRequestDto | null> {
  await expireStale();
  const row = rowsToObjects(await rqlite.query('SELECT * FROM access_requests WHERE id = ?', [id]))[0];
  if (!row) return null;
  const who = requesterOf(viewer);
  const mine = row.requester_type === who.type && row.requester_id === who.id;
  const decider = viewer.authType !== 'api_key' && hasRole(viewer.role, 'operator');
  if (!mine && (!decider || (row.server_id && !(await serverVisible(viewer, String(row.server_id)))))) return null;
  return toDto(row, await registeredPermissionDefs(), await serverNames());
}

export async function cancelRequest(viewer: TokenPayload, id: string): Promise<boolean> {
  const who = requesterOf(viewer);
  const r = await rqlite.execute("UPDATE access_requests SET status = 'cancelled', decided_at = ? WHERE id = ? AND status = 'pending' AND requester_type = ? AND requester_id = ?",
    [nowIso(), id, who.type, who.id]);
  if (r.rows_affected !== 1) return false;
  await resolveByKeyPrefix(`access-request:${id}`);
  return true;
}

/** The requester as a principal again (for running a one-time action as them), or null if it can no longer act. */
export { requesterPayload };

/** The permission group that holds a requester's approved grants (made on first use). */
async function approvedGroupFor(type: 'user' | 'api_key', id: string, name: string): Promise<string> {
  const groupId = `access-${type}-${id}`.slice(0, 64);
  const now = nowIso();
  await rqlite.executeBatch([
    { sql: 'INSERT OR IGNORE INTO permission_groups (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      params: [groupId, `Approved requests: ${name} (${id.slice(0, 8)})`.slice(0, 60), 'Grants approved from access requests. Edit or delete it like any group.', now, now] },
    type === 'user'
      ? { sql: 'INSERT OR IGNORE INTO user_groups (user_id, group_id) VALUES (?, ?)', params: [id, groupId] }
      : { sql: 'INSERT OR IGNORE INTO api_key_groups (api_key_id, group_id) VALUES (?, ?)', params: [id, groupId] },
  ], { transaction: true });
  return groupId;
}

/** The person behind an API key (whoever created it), or null when the key records no creator. */
async function apiKeyCreator(apiKeyId: string): Promise<string | null> {
  const r = await rqlite.query('SELECT created_by FROM api_keys WHERE id = ?', [apiKeyId]);
  const v = r.values?.[0]?.[0];
  return v ? String(v) : null;
}

/**
 * The decision in the bell of the person behind the request: the requester, or for an API key the person who made the key
 * (keys have no bell; they read the request with GET /api/access-requests/:id?wait=…). Never throws.
 */
async function tellRequester(row: Record<string, unknown>, status: string, outcome: unknown, approverName: string, note: string | null, serverId: string | null, defs: readonly PermissionDef[]): Promise<void> {
  try {
    const isKey = row.requester_type === 'api_key';
    const recipient = isKey ? await apiKeyCreator(String(row.requester_id)) : String(row.requester_id);
    if (!recipient) return;
    const dto = await toDto(row, defs, await serverNames());
    const whose = isKey ? `Your API key ${String(row.requester_name)}'s request` : 'Your request';
    const what = status === 'approved' ? 'was approved' : status === 'denied' ? 'was denied' : 'was approved, but could not be carried out';
    const err = status === 'failed' && outcome && typeof outcome === 'object' ? (outcome as { error?: unknown }).error : undefined;
    const result = err ? ` ${typeof err === 'string' ? err : JSON.stringify(err)}`.slice(0, 400) : '';
    await notify({
      kind: 'access_decision', severity: status === 'approved' ? 'success' : status === 'denied' ? 'warning' : 'critical',
      title: `${whose} ${what}`.slice(0, 200),
      message: `${dto.summary}: decided by ${approverName}.${note ? ` Note: ${note}` : ''}${result}`,
      link: `/settings/access-requests?id=${String(row.id)}`, dedupeKey: `access-decision:${String(row.id)}`,
      serverId, recipientUserId: recipient,
    });
  } catch (err) {
    console.warn(`[access] could not tell the requester about ${String(row.id)}: ${err instanceof Error ? err.message : err}`);
  }
}

/** Wait (up to `seconds`) until a request is no longer pending, so a requester can hold one call open instead of polling. */
export async function waitForDecision(viewer: TokenPayload, id: string, seconds: number, stepMs = 2000): Promise<AccessRequestDto | null> {
  const until = Date.now() + Math.min(Math.max(seconds, 0), MAX_WAIT_SECONDS) * 1000;
  for (;;) {
    const r = await getRequest(viewer, id);
    if (!r || r.status !== 'pending' || Date.now() + stepMs > until) return r;
    await new Promise(res => setTimeout(res, stepMs));
  }
}

/** Longest ?wait= (seconds): below the 60 s proxy read timeouts of nginx and most tunnels. */
export const MAX_WAIT_SECONDS = 50;

export async function decideRequest(approver: TokenPayload, id: string, decision: 'approve' | 'deny', note: string | null, ip?: string): Promise<AccessRequestDto> {
  await expireStale();
  if (approver.authType === 'api_key') throw new RequestError('Requests are decided by a signed-in person, not an API key', 403, 'FORBIDDEN');
  const row = rowsToObjects(await rqlite.query('SELECT * FROM access_requests WHERE id = ?', [id]))[0];
  if (!row) throw new RequestError('Request not found', 404, 'NOT_FOUND');
  if (row.status !== 'pending') throw new RequestError(`This request is already ${row.status}`, 409, 'NOT_PENDING');
  if (row.requester_type === 'user' && row.requester_id === String(approver.userId)) throw new RequestError('You cannot decide your own request', 403, 'FORBIDDEN');
  // An API key has no bell of its own: its creator is the person it acts for, and they must not decide it either.
  if (row.requester_type === 'api_key' && (await apiKeyCreator(String(row.requester_id))) === String(approver.userId)) {
    throw new RequestError('You cannot decide a request from your own API key', 403, 'FORBIDDEN');
  }
  const defs = await registeredPermissionDefs();
  const def = permissionDef(String(row.permission), defs);
  if (!def) throw new RequestError('That permission no longer exists', 409, 'UNKNOWN_PERMISSION');
  const serverId = row.server_id ? String(row.server_id) : null;
  const resource: GrantResource | null = row.resource_kind ? { kind: row.resource_kind as GrantResource['kind'], name: String(row.resource_name) } : null;
  const action = parse<StoredAction | null>(row.action, null);

  // The approver must hold what they give away, for that server and stack/container (a prefix: the whole server).
  if (serverId && !(await serverVisible(approver, serverId))) throw new RequestError('Request not found', 404, 'NOT_FOUND');
  if (audienceFor(def) === 'admin' && approver.role !== 'admin') throw new RequestError(`"${def.label}" is ${def.risk === 'high' ? 'high risk' : 'Full access only'}: only Full access can decide it`, 403, 'FORBIDDEN');
  let ctx = contextOf(resource);
  if (row.kind === 'terminal' && action?.container) ctx = { kind: 'container', name: action.container };
  if (row.kind === 'one_time' && action?.widgetType && action.actionId && serverId) {
    // The action's target as the action route sees it (a container with its stack, from the widget's data).
    const { loadWidgetSpec } = await import('@/lib/widgets/runtime/execute');
    const loaded = await loadWidgetSpec(action.widgetType);
    const a = loaded?.spec.actions.find(x => x.id === action.actionId);
    if (loaded && a?.target) {
      const { resolveTarget } = await import('@/lib/widgets/runtime/resource-check');
      const params = action.params ?? {};
      ctx = await resolveTarget(serverId, loaded, a.target, params[a.target.param], 'byKind' in a.target ? (params[a.target.byKind] ?? a.params[a.target.byKind]?.default) : undefined).catch(() => ctx);
    }
  }
  if (decision === 'approve' && !(await hasPermission(approver, def.id, serverId, resource && !ctx ? null : ctx))) {
    throw new RequestError(`You do not hold "${def.label}" there yourself, so you cannot give it`, 403, 'FORBIDDEN');
  }

  const decidedAt = nowIso();
  const claim = await rqlite.execute(
    "UPDATE access_requests SET status = ?, decided_by = ?, decided_by_name = ?, decided_at = ?, decision_note = ? WHERE id = ? AND status = 'pending'",
    [decision === 'approve' ? 'approved' : 'denied', String(approver.userId), approver.username, decidedAt, note, id]);
  if (claim.rows_affected !== 1) throw new RequestError('This request was decided a moment ago', 409, 'NOT_PENDING');
  await resolveByKeyPrefix(`access-request:${id}`);

  let result: unknown = null;
  let finalStatus = decision === 'approve' ? 'approved' : 'denied';
  if (decision === 'approve') {
    const requester = await requesterPayload(String(row.requester_type), String(row.requester_id));
    if (!requester) {
      finalStatus = 'failed';
      result = { error: 'The requester can no longer act (deleted, disabled, revoked or expired)' };
    } else if (row.kind === 'grant') {
      const groupId = await approvedGroupFor(row.requester_type as 'user' | 'api_key', String(row.requester_id), String(row.requester_name));
      const hours = row.duration_hours === null || row.duration_hours === undefined ? null : Number(row.duration_hours);
      const expiresAt = hours ? new Date(Date.now() + hours * 3600_000).toISOString() : null;
      await rqlite.execute(
        `INSERT INTO permission_grants (id, group_id, permission, scope_type, scope_id, effect, resource_kind, resource_name, expires_at)
         VALUES (?, ?, ?, ?, ?, 'allow', ?, ?, ?)
         ON CONFLICT(group_id, permission, scope_type, scope_id, resource_kind, resource_name) DO UPDATE SET effect = 'allow',
           expires_at = CASE WHEN excluded.expires_at IS NULL OR permission_grants.expires_at IS NULL THEN NULL
                             ELSE max(excluded.expires_at, permission_grants.expires_at) END`,
        [crypto.randomUUID(), groupId, def.id, serverId ? 'server' : 'all', serverId ?? '', resource?.kind ?? '', resource?.name ?? '', expiresAt]);
      invalidatePermissionCache();
      result = { group_id: groupId, expires_at: expiresAt };
    } else if (row.kind === 'command' && serverId && action?.command) {
      try {
        const { runServerCommand } = await import('@/lib/exec/run-command');
        const r = await runServerCommand({
          serverId, command: action.command, as: action.as === 'service' ? 'service' : 'user',
          userId: requester.userId, approvedBy: approver.username, requestId: id, ip,
        });
        result = { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut, account: r.account, as: r.as };
      } catch (e) {
        finalStatus = 'failed';
        result = { error: e instanceof Error ? e.message : String(e) };
      }
    } else if (row.kind === 'terminal' && serverId) {
      try {
        const { getMcpTerminalManager, principalKey } = await import('@/lib/terminal/mcp-sessions');
        result = await getMcpTerminalManager().open(principalKey(requester), requester, {
          serverId, as: action?.as === 'service' ? 'service' : 'user', container: action?.container ?? null, ip,
        });
      } catch (e) {
        finalStatus = 'failed';
        result = { error: e instanceof Error ? e.message : String(e) };
      }
    } else if (action?.widgetType && action.actionId) {
      const { loadWidgetSpec } = await import('@/lib/widgets/runtime/execute');
      const { runWidgetAction } = await import('@/lib/widgets/runtime/run-action');
      const loaded = await loadWidgetSpec(action.widgetType);
      const a = loaded?.spec.actions.find(x => x.id === action.actionId);
      if (!loaded || !a || !serverId) {
        finalStatus = 'failed';
        result = { error: 'The widget action no longer exists' };
      } else {
        try {
          const res = await runWidgetAction(requester, serverId, loaded, a, { params: action.params ?? {}, confirm: true }, { ip, approvedBy: approver.username, requestId: id });
          const json = await res.json().catch(() => null) as { data?: unknown; error?: unknown } | null;
          result = { http_status: res.status, ...(json?.data !== undefined ? { data: json.data } : {}), ...(json?.error ? { error: json.error } : {}) };
          if (res.status >= 400) finalStatus = 'failed';
        } catch (e) {
          finalStatus = 'failed';
          result = { error: e instanceof Error ? e.message : String(e) };
        }
      }
    }
  }
  await rqlite.execute('UPDATE access_requests SET status = ?, result = ? WHERE id = ?', [finalStatus, result === null ? null : JSON.stringify(result).slice(0, 20000), id]);
  await tellRequester(row, finalStatus, result, approver.username, note, serverId, defs);
  await logAudit({
    userId: approver.userId, serverId: serverId ?? undefined, action: decision === 'approve' ? 'access.approve' : 'access.deny', category: 'access',
    status: finalStatus === 'failed' ? 'failure' : 'success', ipAddress: ip,
    details: JSON.stringify({ id, requester: row.requester_name, kind: row.kind, permission: def.id, server: serverId, resource, note, outcome: finalStatus }).slice(0, 900),
  }).catch(() => undefined);
  return (await toDto(rowsToObjects(await rqlite.query('SELECT * FROM access_requests WHERE id = ?', [id]))[0], defs, await serverNames()));
}
