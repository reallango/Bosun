/** The fixed Bosun tools. Each uses the same library function as its REST counterpart. */
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';
import { visibleServerIds, serverVisible } from '@/lib/permissions/effective';
import { getClusterSummary } from '@/lib/cluster/status';
import { bosunVersion } from '@/lib/update/version';
import { updateStatus } from '@/lib/update/rollout';
import { getJob, viewOf } from '@/lib/widgets/jobs/store';
import { mayUse } from '@/lib/widgets/jobs/tasks';
import { accessView } from '@/lib/access/view';
import { validateRequestInput } from '@/lib/access/validate';
import { createRequest, waitForDecision } from '@/lib/access/requests';
import { accessRequestLimiter } from '@/lib/access/limiter';
import { registeredPermissionDefs } from '@/lib/permissions/store';
import { createSchedule, listSchedules, runScheduleNow } from '@/lib/schedules/service';
import { listForViewer } from '@/lib/notifications/store';
import { hasPermission } from '@/lib/permissions/authorize';
import { allServerContexts } from '@/lib/permissions/store';
import type { TokenPayload } from '@/lib/auth/jwt';
import type { JobRecord } from '@/lib/widgets/jobs/store';
import type { CatalogTool, ToolResult } from './types';
import { waitForJob, MAX_JOB_WAIT_SECONDS } from './jobs';
import { errorResult, formatAccessRequest, formatJob, textResult, truncate } from './format';

export interface CoreContext {
  auth: TokenPayload;
  ip?: string;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function intArg(args: Record<string, unknown>, name: string, fallback: number, min: number, max: number): number {
  const n = Number(args[name]);
  return Number.isFinite(n) ? Math.min(Math.max(Math.round(n), min), max) : fallback;
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));


interface ServerRow extends Record<string, unknown> {
  id: string;
  name: string;
  platform?: string | null;
  is_online?: number | boolean | null;
  last_seen?: string | null;
  last_error?: string | null;
  cpu_cores?: number | null;
  total_ram_mb?: number | null;
}

function serverLine(s: ServerRow, detail = false): string {
  const state = s.is_online ? 'online' : 'offline';
  const bits = [String(s.id), String(s.name), state, String(s.platform || 'linux')];
  if (s.cpu_cores) bits.push(`${s.cpu_cores} cores`);
  if (s.total_ram_mb) bits.push(`${s.total_ram_mb} MB RAM`);
  if (s.last_seen) bits.push(`seen ${s.last_seen}`);
  if (s.last_error) bits.push(`error: ${String(s.last_error).slice(0, 160)}`);
  if (detail) bits.push(`host=${String(s.hostname ?? '')}`);
  return bits.join('  ');
}

async function visibleServers(auth: TokenPayload): Promise<ServerRow[]> {
  const visible = await visibleServerIds(auth);
  return (rowsToObjects(await rqlite.query(
    'SELECT id, name, hostname, ssh_port, ssh_user, ssh_key_id, shell_user, shell_key_id, platform, os_type, os_version, cpu_model, cpu_cores, total_ram_mb, is_online, last_seen, last_error, poll_enabled, poll_interval_sec, capabilities, mac_address, mac_address_alt, notes, tags FROM servers ORDER BY name COLLATE NOCASE',
  )) as unknown as ServerRow[]).filter(s => visible === '*' || visible.has(String(s.id)));
}

function metricsFor(rows: Record<string, unknown>[]): Map<string, { cpu?: number; mem?: number; load?: number; disk?: number }> {
  const out = new Map<string, { cpu?: number; mem?: number; load?: number; disk?: number }>();
  for (const row of rows) {
    const serverId = String(row.server_id);
    const m = out.get(serverId) ?? {};
    const value = typeof row.value === 'number' ? row.value : Number(row.value);
    if (!Number.isFinite(value)) continue;
    if (row.metric === 'cpu.usage') m.cpu = value;
    else if (row.metric === 'mem.used_pct') m.mem = value;
    else if (row.metric === 'cpu.load1') m.load = value;
    else if (row.metric === 'disk.max_used_pct') m.disk = value;
    out.set(serverId, m);
  }
  return out;
}

async function bosunOverview(ctx: CoreContext): Promise<ToolResult> {
  const [summary, servers] = await Promise.all([getClusterSummary(), visibleServers(ctx.auth)]);
  const version = bosunVersion();
  const metrics = metricsFor(rowsToObjects(await rqlite.query(
    `SELECT server_id, metric, value FROM metric_samples
     WHERE metric IN ('cpu.usage', 'mem.used_pct', 'cpu.load1', 'disk.max_used_pct')
       AND ts = (SELECT MAX(m2.ts) FROM metric_samples m2 WHERE m2.server_id = metric_samples.server_id AND m2.metric = metric_samples.metric)`,
  )));
  const serverLines = servers.map(s => {
    const m = metrics.get(String(s.id)) ?? {};
    const bits = [serverLine(s)];
    if (m.cpu !== undefined) bits.push(`cpu ${m.cpu}%`);
    if (m.mem !== undefined) bits.push(`mem ${m.mem}%`);
    if (m.load !== undefined) bits.push(`load ${m.load}`);
    if (m.disk !== undefined) bits.push(`disk ${m.disk}%`);
    return `  ${bits.join('  ')}`;
  });
  const text = [
    `Bosun ${version.short} (${version.channel})`,
    `Cluster: ${summary.state}${summary.leader_id ? `, leader ${summary.leader_id}` : ''}, ${summary.reachable_voters}/${summary.voters} voters reachable${summary.poller ? `, poller ${summary.poller.node}${summary.poller.stale ? ' (stale)' : ''}` : ''}`,
    `Servers (${servers.length}):`,
    ...(serverLines.length ? serverLines : ['  none']),
  ].join('\n');
  return textResult(text, {
    version,
    cluster: summary,
    servers: servers.map(s => ({
      id: s.id, name: s.name, online: !!s.is_online, platform: s.platform || 'linux',
      last_seen: s.last_seen ?? null, last_error: s.last_error ?? null,
      cpu_cores: s.cpu_cores ?? null, total_ram_mb: s.total_ram_mb ?? null,
      metrics: metrics.get(String(s.id)) ?? {},
    })),
  });
}

async function serversList(ctx: CoreContext, args: Record<string, unknown>): Promise<ToolResult> {
  const servers = await visibleServers(ctx.auth);
  const detail = args.detail === true;
  return textResult(
    servers.length ? servers.map(s => `  ${serverLine(s, detail)}`).join('\n') : 'No servers you may see.',
    { servers: servers.map(s => detail ? s : { id: s.id, name: s.name, online: !!s.is_online, platform: s.platform || 'linux', cpu_cores: s.cpu_cores ?? null, total_ram_mb: s.total_ram_mb ?? null, last_seen: s.last_seen ?? null, last_error: s.last_error ?? null }) },
  );
}

function parseJsonField(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

async function serverGet(ctx: CoreContext, args: Record<string, unknown>): Promise<ToolResult> {
  const serverId = requiredString(args.server_id, 'server_id');
  if (!(await serverVisible(ctx.auth, serverId))) return errorResult(`Server not found: ${serverId}`);
  const row = rowsToObjects(await rqlite.query('SELECT * FROM servers WHERE id = ?', [serverId]))[0];
  if (!row) return errorResult(`Server not found: ${serverId}`);
  const detail = args.detail === true;
  const server = detail ? { ...row, capabilities: parseJsonField(row.capabilities), tags: parseJsonField(row.tags) } : {
    id: row.id, name: row.name, hostname: row.hostname, platform: row.platform || 'linux',
    os_type: row.os_type ?? null, os_version: row.os_version ?? null, kernel_version: row.kernel_version ?? null,
    cpu_model: row.cpu_model ?? null, cpu_cores: row.cpu_cores ?? null, total_ram_mb: row.total_ram_mb ?? null,
    is_online: !!row.is_online, last_seen: row.last_seen ?? null, last_error: row.last_error ?? null,
    poll_enabled: !!row.poll_enabled, poll_interval_sec: row.poll_interval_sec ?? null,
    capabilities: parseJsonField(row.capabilities), tags: parseJsonField(row.tags),
  };
  return textResult(serverLine(row as ServerRow, detail), { server });
}

async function jobAccess(auth: TokenPayload, job: JobRecord): Promise<string | null> {
  return (await mayUse(auth, job)) ? null : 'Job not found';
}

async function jobWait(ctx: CoreContext, args: Record<string, unknown>): Promise<ToolResult> {
  const jobId = requiredString(args.job_id, 'job_id');
  const timeout = intArg(args, 'timeout', 30, 1, MAX_JOB_WAIT_SECONDS);
  const first = await getJob(jobId);
  if (!first) return errorResult(`Job not found: ${jobId}`);
  const denied = await jobAccess(ctx.auth, first);
  if (denied) return errorResult(denied);
  const { job, timedOut } = await waitForJob(jobId, timeout, { getJob, sleep });
  if (!job) return errorResult(`Job not found: ${jobId}`);
  const note = timedOut ? `\nStill running after ${timeout}s; call job_wait again to keep waiting.` : '';
  return textResult(`${formatJob(job)}${note}`, {
    job: { ...viewOf(job), server_id: job.serverId, widget_type: job.widgetType, action_id: job.actionId },
    timed_out: timedOut,
  });
}

async function jobLog(ctx: CoreContext, args: Record<string, unknown>): Promise<ToolResult> {
  const jobId = requiredString(args.job_id, 'job_id');
  const job = await getJob(jobId);
  if (!job) return errorResult(`Job not found: ${jobId}`);
  const denied = await jobAccess(ctx.auth, job);
  if (denied) return errorResult(denied);
  const log = job.log || 'No log output.';
  return textResult(`Job ${job.id}: ${job.status}\n${truncate(log, 60_000)}`, {
    job_id: job.id, status: job.status, message: job.message ?? null, log,
  });
}

async function accessWhoami(ctx: CoreContext): Promise<ToolResult> {
  const view = await accessView(ctx.auth);
  const held = Object.entries(view.held);
  const all = held.filter(([, v]) => v === '*').map(([k]) => k);
  const limited = held.filter(([, v]) => v !== '*');
  const servers = view.servers.map(s => `${s.id} (${s.name})`);
  const pending = view.requests.filter(r => r.status === 'pending');
  const text = [
    `Principal: ${view.principal.name} (${view.principal.type}) — ${view.principal.level}`,
    `Servers (${servers.length}): ${servers.length ? servers.join(', ') : 'none'}`,
    all.length
      ? `Held on every server (${all.length}): ${all.slice(0, 30).join(', ')}${all.length > 30 ? `, … ${all.length - 30} more` : ''}`
      : 'Held on every server: none beyond your access level',
    limited.length ? `Limited grants: ${limited.slice(0, 15).map(([p, ids]) => `${p} on ${(ids as string[]).join(', ')}`).join('; ')}` : undefined,
    pending.length ? `Pending requests (${pending.length}): ${pending.map(r => `${r.id} ${r.summary}`).join('; ')}` : 'Pending requests: none',
  ].filter(Boolean).join('\n');
  return textResult(text, view as unknown as Record<string, unknown>);
}

async function accessRequest(ctx: CoreContext, args: Record<string, unknown>): Promise<ToolResult> {
  const input = validateRequestInput(args, await registeredPermissionDefs());
  if (!input.ok) return errorResult(input.error);
  if (!accessRequestLimiter.consume(String(ctx.auth.userId)).allowed) return errorResult('Too many requests; try again later (RATE_LIMITED).');
  const request = await createRequest(ctx.auth, input.value);
  return textResult(formatAccessRequest(request), { request });
}

async function accessRequestWait(ctx: CoreContext, args: Record<string, unknown>): Promise<ToolResult> {
  const requestId = requiredString(args.request_id, 'request_id');
  const timeout = intArg(args, 'timeout', 30, 1, 50);
  const request = await waitForDecision(ctx.auth, requestId, timeout);
  if (!request) return errorResult(`Access request not found: ${requestId}`);
  const note = request.status === 'pending' ? `\nStill pending after ${timeout}s; call access_request_wait again to keep waiting.` : '';
  return textResult(`${formatAccessRequest(request)}${note}`, { request });
}

function scheduleLine(s: Awaited<ReturnType<typeof listSchedules>>[number]): string {
  const state = s.enabled ? 'enabled' : 'paused';
  const last = s.last_run ? `, last ${s.last_run.status}` : '';
  return `  ${s.id}  ${s.name}  ${s.cron} ${s.timezone}  ${state}  next ${s.next_run_at ?? '-'}${last}  ${s.server_name ?? s.server_id}  ${s.widget_type}/${s.kind_label}`;
}

async function schedulesList(ctx: CoreContext): Promise<ToolResult> {
  const schedules = await listSchedules(ctx.auth);
  return textResult(
    schedules.length ? schedules.map(scheduleLine).join('\n') : 'No schedules you may manage.',
    { schedules },
  );
}

async function scheduleCreate(ctx: CoreContext, args: Record<string, unknown>): Promise<ToolResult> {
  const schedule = await createSchedule(ctx.auth, args, ctx.ip);
  return textResult(scheduleLine(schedule), { schedule });
}

async function scheduleRunNow(ctx: CoreContext, args: Record<string, unknown>): Promise<ToolResult> {
  const scheduleId = requiredString(args.schedule_id, 'schedule_id');
  const outcome = await runScheduleNow(ctx.auth, scheduleId, ctx.ip);
  const lines = [`started: ${outcome.started}`, `status: ${outcome.status ?? '-'}`];
  if (outcome.message) lines.push(`message: ${outcome.message}`);
  if (outcome.runId) lines.push(`run: ${outcome.runId}`);
  return textResult(lines.join('\n'), { outcome });
}

async function updateStatusTool(ctx: CoreContext): Promise<ToolResult> {
  if (ctx.auth.role !== 'admin') return errorResult('Insufficient permissions: requires "Full access" access (FORBIDDEN).');
  const status = await updateStatus();
  const nodes = status.nodes.map(n => `  ${n.id}  ${n.commit ?? 'unknown'}${n.self ? ' (this node)' : ''}${n.reachable === false ? ' (unreachable)' : ''}${n.healthy === false ? ' (unhealthy)' : ''}`);
  const text = [
    `Bosun ${status.running.short} (${status.running.channel})`,
    `Update channel: ${status.config.channel}, image ${status.config.image}`,
    `Latest: ${status.latest?.commit ?? 'not checked yet'}${status.latest?.checked_at ? ` (checked ${status.latest.checked_at})` : ''}${status.latest?.error ? ` — ${status.latest.error}` : ''}`,
    `Nodes (${status.nodes.length}):`,
    ...(nodes.length ? nodes : ['  none']),
    status.problems.length ? `Problems: ${status.problems.join('; ')}` : 'Problems: none',
    status.rollout ? `Rollout: ${status.rollout.kind} ${status.rollout.status} → ${status.rollout.target} (started by ${status.rollout.started_by})` : 'Rollout: none',
  ].join('\n');
  return textResult(text, status as unknown as Record<string, unknown>);
}

async function notificationsList(ctx: CoreContext, args: Record<string, unknown>): Promise<ToolResult> {
  const limit = intArg(args, 'limit', 25, 1, 100);
  const notifications = await listForViewer(ctx.auth, { limit, unreadOnly: args.unread_only === true });
  const lines = notifications.map(n => {
    const state = n.read ? 'read' : 'unread';
    return `  ${n.created_at}  [${n.type}] ${state}  ${n.title}${n.message ? ` — ${truncate(n.message, 200)}` : ''}`;
  });
  return textResult(lines.length ? lines.join('\n') : 'No notifications you may see.', { notifications });
}



export async function callCoreTool(ctx: CoreContext, tool: CatalogTool, args: Record<string, unknown>): Promise<ToolResult> {
  switch (tool.coreName) {
    case 'bosun_overview': return bosunOverview(ctx);
    case 'servers_list': return serversList(ctx, args);
    case 'server_get': return serverGet(ctx, args);
    case 'job_wait': return jobWait(ctx, args);
    case 'job_log': return jobLog(ctx, args);
    case 'access_whoami': return accessWhoami(ctx);
    case 'access_request': return accessRequest(ctx, args);
    case 'access_request_wait': return accessRequestWait(ctx, args);
    case 'schedules_list': return schedulesList(ctx);
    case 'schedule_create': return scheduleCreate(ctx, args);
    case 'schedule_run_now': return scheduleRunNow(ctx, args);
    case 'update_status': return updateStatusTool(ctx);
    case 'notifications_list': return notificationsList(ctx, args);
    default: return errorResult(`Unknown tool: ${tool.name}`);
  }
}
