/**
 * Schedules: create, read, change, delete and run now, with the same rules the engine applies on every run.
 *
 * A schedule is one kind a widget package declares, kept for one server (and optionally one stack/container). Its
 * creator is stored like an access request's requester, and every write and every run re-checks
 * `schedules.manage` on that server plus the permission the widget declared for the dataset or action.
 */
import crypto from 'crypto';
import type { TokenPayload } from '@/lib/auth/jwt';
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';
import { logAudit } from '@/lib/audit/logger';
import { hasPermission, permittedResources } from '@/lib/permissions/authorize';
import { serverVisible, visibleServerIds } from '@/lib/permissions/effective';
import { loadWidgetSpec, type LoadedSpec } from '@/lib/widgets/runtime/execute';
import { resolveTarget } from '@/lib/widgets/runtime/resource-check';
import type { ScheduleSpec } from '@/lib/widgets/runtime/spec-schedules';
import { validateParamValues } from '@/lib/widgets/runtime/script-run';
import { requesterOf } from '@/lib/access/requests';
import { cronProblem, nextRun, validateTimeZone } from './cron';
import { executeScheduleRun, nextRunAt, type RunOutcome } from './engine';
import {
  describeRun, parseOptions, type ScheduleArg, type ScheduleDto, type ScheduleRunDto, type ScheduleRow, type StoredOptions,
} from './model';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export class ScheduleError extends Error {
  constructor(message: string, readonly status = 400, readonly code = 'VALIDATION') { super(message); }
}

export interface ScheduleInput {
  name?: unknown;
  widget_type?: unknown;
  schedule_kind?: unknown;
  server_id?: unknown;
  resource_kind?: unknown;
  resource_name?: unknown;
  cron?: unknown;
  timezone?: unknown;
  enabled?: unknown;
  options?: unknown;
}

export interface ScheduleKindDto {
  widget_type: string;
  widget_name: string;
  package_id: string;
  id: string;
  label: string;
  description?: string;
  target: 'server' | 'stack' | 'container' | 'byKind';
  run: 'dataset' | 'action';
}

const nowIso = () => new Date().toISOString();

function text(v: unknown, field: string, max: number): string {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw new ScheduleError(`${field} must be text of 1-${max} characters`);
  return v.trim();
}

function argMap(v: unknown, field: string): Record<string, ScheduleArg> | undefined {
  if (v === undefined) return undefined;
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ScheduleError(`${field} must be an object`);
  const out: Record<string, ScheduleArg> = {};
  for (const [k, value] of Object.entries(v)) {
    if (!/^[a-z][a-zA-Z0-9_]{0,29}$/.test(k)) throw new ScheduleError(`${field}: "${k}" is not a parameter name`);
    if (!(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')) {
      throw new ScheduleError(`${field}: "${k}" must be a string, number or boolean`);
    }
    out[k] = value;
  }
  if (Object.keys(out).length > 40) throw new ScheduleError(`${field} may hold at most 40 values`);
  return out;
}

function inputOptions(raw: unknown, dataset: boolean): StoredOptions {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ScheduleError('options must be an object');
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) if (k !== 'args' && k !== 'params' && k !== 'keepRuns') throw new ScheduleError('options only knows "args", "params" and "keepRuns"');
  const args = argMap(o.args, 'options.args');
  const params = argMap(o.params, 'options.params');
  if (dataset && params) throw new ScheduleError('A dataset schedule takes "args", not "params"');
  if (!dataset && args) throw new ScheduleError('An action schedule takes "params", not "args"');
  if (o.keepRuns !== undefined && !(Number.isInteger(o.keepRuns) && Number(o.keepRuns) >= 10 && Number(o.keepRuns) <= 1000)) {
    throw new ScheduleError('options.keepRuns must be a whole number from 10 to 1000');
  }
  return { ...(args ? { args } : {}), ...(params ? { params } : {}), ...(o.keepRuns !== undefined ? { keepRuns: Number(o.keepRuns) } : {}) };
}

async function loadKind(widgetType: string, kindId: string): Promise<{ loaded: LoadedSpec; kind: ScheduleSpec }> {
  const loaded = await loadWidgetSpec(widgetType);
  const kind = loaded?.spec.schedules?.find(k => k.id === kindId);
  if (!loaded || !kind) throw new ScheduleError('That schedule kind is not offered by an installed widget', 404, 'NOT_FOUND');
  return { loaded, kind };
}

interface Normalized {
  name: string;
  serverId: string;
  resourceKind: '' | 'stack' | 'container';
  resourceName: string;
  cron: string;
  timezone: string;
  enabled: boolean;
  options: StoredOptions;
  widgetType: string;
  kindId: string;
}

async function normalize(
  viewer: TokenPayload,
  raw: ScheduleInput,
  existing?: { row: ScheduleRow },
): Promise<{ value: Normalized; loaded: LoadedSpec; kind: ScheduleSpec }> {
  const widgetType = text(raw.widget_type ?? existing?.row.widget_type, 'widget_type', 60);
  const kindId = text(raw.schedule_kind ?? existing?.row.schedule_kind, 'schedule_kind', 40);
  const serverId = text(raw.server_id ?? existing?.row.server_id, 'server_id', 60);
  const name = text(raw.name ?? existing?.row.name, 'name', 80);
  const cron = text(raw.cron ?? existing?.row.cron, 'cron', 100);
  const timezone = text(raw.timezone ?? existing?.row.timezone, 'timezone', 64);
  const enabled = raw.enabled === undefined ? (existing ? existing.row.enabled === 1 : true) : raw.enabled === true;
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') throw new ScheduleError('enabled must be true or false');

  const exists = await rqlite.query('SELECT 1 FROM servers WHERE id = ?', [serverId]);
  if (!exists.values?.length || !(await serverVisible(viewer, serverId))) throw new ScheduleError('Server not found', 404, 'NOT_FOUND');
  if (!(await hasPermission(viewer, 'schedules.manage', serverId))) throw new ScheduleError('You do not hold "Manage schedules" on that server', 403, 'FORBIDDEN');

  const { loaded, kind } = await loadKind(widgetType, kindId);
  const run = describeRun(loaded, kind);
  if (!run) throw new ScheduleError('That schedule kind no longer runs anything in this widget', 409, 'STALE_KIND');

  const aimed = kind.target === 'stack' || kind.target === 'container' || kind.target === 'byKind';
  let resourceKind: '' | 'stack' | 'container' = '';
  let resourceName = '';
  if (aimed) {
    const wanted = raw.resource_kind ?? existing?.row.resource_kind;
    const wantedName = raw.resource_name ?? existing?.row.resource_name;
    if (kind.target === 'byKind') {
      if (wanted !== 'stack' && wanted !== 'container') throw new ScheduleError('This schedule kind is for one container or stack: choose which one');
      resourceKind = wanted;
    } else {
      if (wanted !== kind.target) throw new ScheduleError(`This schedule kind is for one ${kind.target}: choose which one`);
      resourceKind = kind.target as 'stack' | 'container';
    }
    if (typeof wantedName !== 'string' || !NAME_RE.test(wantedName)) throw new ScheduleError(`resource_name must name the ${resourceKind}`);
    resourceName = wantedName;
  } else if ((raw.resource_kind ?? existing?.row.resource_kind) || (raw.resource_name ?? existing?.row.resource_name)) {
    throw new ScheduleError('This schedule kind runs on the whole server, so it takes no stack or container');
  }

  if (cronProblem(cron)) throw new ScheduleError(`Cron expression: ${cronProblem(cron)}`);
  if (!validateTimeZone(timezone)) throw new ScheduleError('timezone must be an IANA name such as Europe/Berlin');
  if (!nextRun(cron, timezone, new Date(), { maxDays: 366 * 5 })) throw new ScheduleError('This cron expression never runs');

  const options = raw.options === undefined ? (existing ? parseOptions(existing.row.options) : {}) : inputOptions(raw.options, 'dataset' in kind.run);
  const fixed: Record<string, ScheduleArg> = 'dataset' in kind.run
    ? { ...(kind.options?.args ?? {}), ...(options.args ?? {}) }
    : { ...(kind.run.params ?? {}), ...(options.params ?? {}) };
  if (aimed) {
    fixed[run.targetParam as string] = resourceName;
    if (run.targetKindParam) fixed[run.targetKindParam] = resourceKind;
  }
  for (const [param, spec] of Object.entries(run.params)) {
    if (fixed[param] === undefined && spec.default !== undefined) fixed[param] = spec.default as ScheduleArg;
  }
  try {
    validateParamValues(run.params, fixed);
  } catch (err) {
    throw new ScheduleError(err instanceof Error ? err.message : String(err), 400, 'INVALID_PARAMS');
  }

  let ctx = null;
  if (aimed && run.targetParam) {
    try {
      ctx = await resolveTarget(serverId, loaded, { kind: resourceKind as 'stack' | 'container', param: run.targetParam }, resourceName);
    } catch (err) {
      throw new ScheduleError(err instanceof Error ? err.message : String(err), 400, 'INVALID_TARGET');
    }
  }
  if (!(await hasPermission(viewer, run.permission, serverId, ctx))) {
    throw new ScheduleError(`You do not hold the permission this schedule needs (${run.permission}) there`, 403, 'FORBIDDEN');
  }

  return {
    value: { name, serverId, resourceKind, resourceName, cron, timezone, enabled, options, widgetType, kindId },
    loaded, kind,
  };
}

function toDto(row: ScheduleRow, serverName: string | null, kindLabel: string, lastRun: ScheduleRunDto | null): ScheduleDto {
  const options = parseOptions(row.options);
  return {
    id: row.id,
    name: row.name,
    widget_type: row.widget_type,
    schedule_kind: row.schedule_kind,
    kind_label: kindLabel,
    server_id: row.server_id,
    server_name: serverName,
    resource: row.resource_kind === 'stack' || row.resource_kind === 'container' ? { kind: row.resource_kind, name: row.resource_name } : null,
    cron: row.cron,
    timezone: row.timezone,
    enabled: row.enabled === 1,
    options,
    created_by: { type: row.created_by_type, id: row.created_by_id, name: row.created_by_name },
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_run_at: row.last_run_at,
    next_run_at: row.next_run_at,
    paused_reason: row.paused_reason,
    last_run: lastRun,
  };
}

function runDto(row: Record<string, unknown>): ScheduleRunDto {
  return {
    id: String(row.id), started_at: String(row.started_at), finished_at: row.finished_at ? String(row.finished_at) : null,
    status: row.status as ScheduleRunDto['status'], message: row.message ? String(row.message) : null,
    job_id: row.job_id ? String(row.job_id) : null,
    matched_count: row.matched_count === null || row.matched_count === undefined ? null : Number(row.matched_count),
  };
}

async function kindLabel(widgetType: string, kindId: string): Promise<string> {
  const loaded = await loadWidgetSpec(widgetType).catch(() => null);
  return loaded?.spec.schedules?.find(k => k.id === kindId)?.label ?? kindId;
}

async function latestRunMap(ids: string[]): Promise<Map<string, ScheduleRunDto>> {
  const out = new Map<string, ScheduleRunDto>();
  if (!ids.length) return out;
  const rows = rowsToObjects(await rqlite.query(
    `SELECT * FROM schedule_runs WHERE schedule_id IN (${ids.map(() => '?').join(', ')}) ORDER BY started_at DESC`,
    ids,
  ));
  for (const r of rows) {
    const id = String(r.schedule_id);
    if (!out.has(id)) out.set(id, runDto(r));
  }
  return out;
}

async function serverNameMap(): Promise<Map<string, string>> {
  return new Map(rowsToObjects(await rqlite.query('SELECT id, name FROM servers')).map(r => [String(r.id), String(r.name)]));
}

/** Schedules the viewer may manage: their server must be visible and they must hold `schedules.manage` there. */
export async function listSchedules(viewer: TokenPayload): Promise<ScheduleDto[]> {
  const visible = await visibleServerIds(viewer);
  const rows = (rowsToObjects(await rqlite.query('SELECT * FROM schedules ORDER BY created_at DESC')) as unknown as ScheduleRow[])
    .filter(r => visible === '*' || visible.has(r.server_id));
  const allowed: ScheduleRow[] = [];
  for (const row of rows) if (await hasPermission(viewer, 'schedules.manage', row.server_id)) allowed.push(row);
  const names = await serverNameMap();
  const latest = await latestRunMap(allowed.map(r => r.id));
  const out: ScheduleDto[] = [];
  for (const row of allowed) {
    out.push(toDto(row, names.get(row.server_id) ?? null, await kindLabel(row.widget_type, row.schedule_kind), latest.get(row.id) ?? null));
  }
  return out;
}

async function loadAllowed(viewer: TokenPayload, id: string): Promise<ScheduleRow> {
  const row = rowsToObjects(await rqlite.query('SELECT * FROM schedules WHERE id = ?', [id]))[0] as unknown as ScheduleRow | undefined;
  if (!row || !(await serverVisible(viewer, row.server_id))) throw new ScheduleError('Schedule not found', 404, 'NOT_FOUND');
  if (!(await hasPermission(viewer, 'schedules.manage', row.server_id))) throw new ScheduleError('Schedule not found', 404, 'NOT_FOUND');
  return row;
}

export async function getSchedule(viewer: TokenPayload, id: string): Promise<ScheduleDto> {
  const row = await loadAllowed(viewer, id);
  const names = await serverNameMap();
  const latest = await latestRunMap([row.id]);
  return toDto(row, names.get(row.server_id) ?? null, await kindLabel(row.widget_type, row.schedule_kind), latest.get(row.id) ?? null);
}

export async function createSchedule(viewer: TokenPayload, raw: ScheduleInput, ip?: string): Promise<ScheduleDto> {
  const { value } = await normalize(viewer, raw);
  const who = requesterOf(viewer);
  const id = crypto.randomUUID();
  const at = nowIso();
  const next = value.enabled ? nextRunAt(value.cron, value.timezone) : null;
  await rqlite.execute(
    `INSERT INTO schedules (id, name, widget_type, schedule_kind, server_id, resource_kind, resource_name, cron, timezone, enabled, options,
       created_by_type, created_by_id, created_by_name, created_at, updated_at, next_run_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, value.name, value.widgetType, value.kindId, value.serverId, value.resourceKind, value.resourceName, value.cron, value.timezone,
      value.enabled ? 1 : 0, JSON.stringify(value.options), who.type, who.id, who.name, at, at, next],
  );
  await logAudit({
    userId: viewer.userId, serverId: value.serverId, action: 'schedule.create', category: 'schedules', status: 'success', ipAddress: ip,
    details: JSON.stringify({ schedule: id, widget: value.widgetType, kind: value.kindId, cron: value.cron, timezone: value.timezone, resource: value.resourceKind ? `${value.resourceKind}:${value.resourceName}` : null }).slice(0, 900),
  });
  return getSchedule(viewer, id);
}

export async function updateSchedule(viewer: TokenPayload, id: string, raw: ScheduleInput, ip?: string): Promise<ScheduleDto> {
  const row = await loadAllowed(viewer, id);
  // Pausing only needs "Manage schedules": the widget permission is checked again when the schedule resumes or runs.
  if (raw.enabled === false && Object.keys(raw).every(k => k === 'enabled')) {
    const at = nowIso();
    await rqlite.execute(
      'UPDATE schedules SET enabled = 0, paused_reason = ?, next_run_at = NULL, updated_at = ? WHERE id = ?',
      [`Paused by ${viewer.username}`, at, id],
    );
    await logAudit({
      userId: viewer.userId, serverId: row.server_id, action: 'schedule.pause', category: 'schedules', status: 'success', ipAddress: ip,
      details: JSON.stringify({ schedule: id, reason: `Paused by ${viewer.username}` }).slice(0, 900),
    });
    return getSchedule(viewer, id);
  }
  const { value } = await normalize(viewer, raw, { row });
  const at = nowIso();
  const resuming = value.enabled && row.enabled !== 1;
  const pausing = !value.enabled && row.enabled === 1;
  const next = value.enabled ? (resuming || value.cron !== row.cron || value.timezone !== row.timezone || !row.next_run_at ? nextRunAt(value.cron, value.timezone) : row.next_run_at) : null;
  const pausedReason = value.enabled ? null : (row.paused_reason && !pausing ? row.paused_reason : `Paused by ${viewer.username}`);
  await rqlite.execute(
    `UPDATE schedules SET name = ?, widget_type = ?, schedule_kind = ?, server_id = ?, resource_kind = ?, resource_name = ?, cron = ?, timezone = ?,
       enabled = ?, options = ?, updated_at = ?, next_run_at = ?, paused_reason = ? WHERE id = ?`,
    [value.name, value.widgetType, value.kindId, value.serverId, value.resourceKind, value.resourceName, value.cron, value.timezone,
      value.enabled ? 1 : 0, JSON.stringify(value.options), at, next, pausedReason, id],
  );
  const action = pausing ? 'schedule.pause' : resuming ? 'schedule.resume' : 'schedule.update';
  await logAudit({
    userId: viewer.userId, serverId: value.serverId, action, category: 'schedules', status: 'success', ipAddress: ip,
    details: JSON.stringify({ schedule: id, cron: value.cron, timezone: value.timezone, enabled: value.enabled, next_run_at: next, reason: pausedReason }).slice(0, 900),
  });
  return getSchedule(viewer, id);
}

export async function deleteSchedule(viewer: TokenPayload, id: string, ip?: string): Promise<void> {
  const row = await loadAllowed(viewer, id);
  await rqlite.execute('DELETE FROM schedule_runs WHERE schedule_id = ?', [id]);
  await rqlite.execute('DELETE FROM schedules WHERE id = ?', [id]);
  await logAudit({
    userId: viewer.userId, serverId: row.server_id, action: 'schedule.delete', category: 'schedules', status: 'success', ipAddress: ip,
    details: JSON.stringify({ schedule: id, name: row.name, kind: row.schedule_kind }).slice(0, 900),
  });
}

export async function listRuns(viewer: TokenPayload, id: string, opts: { limit?: number; offset?: number } = {}): Promise<{ runs: ScheduleRunDto[]; nextOffset: number | null }> {
  await loadAllowed(viewer, id);
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
  const offset = Math.max(opts.offset ?? 0, 0);
  const rows = rowsToObjects(await rqlite.query(
    'SELECT * FROM schedule_runs WHERE schedule_id = ? ORDER BY started_at DESC LIMIT ? OFFSET ?',
    [id, limit + 1, offset],
  ));
  const hasMore = rows.length > limit;
  return { runs: rows.slice(0, limit).map(runDto), nextOffset: hasMore ? offset + limit : null };
}

/** Run a schedule now, as its creator. The caller only needs to be allowed to manage it. */
export async function runScheduleNow(viewer: TokenPayload, id: string, ip?: string): Promise<RunOutcome> {
  await loadAllowed(viewer, id);
  const outcome = await executeScheduleRun(id, { trigger: 'manual', actor: viewer, ip });
  await logAudit({
    userId: viewer.userId, action: 'schedule.run', category: 'schedules', status: outcome.started ? 'success' : 'failure', ipAddress: ip,
    details: JSON.stringify({ schedule: id, trigger: 'manual', started: outcome.started, result: outcome.status ?? null }).slice(0, 900),
  });
  if (!outcome.started) throw new ScheduleError(outcome.message ?? 'The schedule did not start', 409, 'RUNNING');
  return outcome;
}

/** Every installed widget's declared schedule kinds the caller may create on this server. */
export async function listScheduleKinds(viewer: TokenPayload, serverId: string): Promise<ScheduleKindDto[]> {
  const exists = await rqlite.query('SELECT 1 FROM servers WHERE id = ?', [serverId]);
  if (!exists.values?.length || !(await serverVisible(viewer, serverId))) throw new ScheduleError('Server not found', 404, 'NOT_FOUND');
  if (!(await hasPermission(viewer, 'schedules.manage', serverId))) return [];
  const widgets = rowsToObjects(await rqlite.query(
    'SELECT type, display_name FROM custom_widgets WHERE enabled = 1 AND package_id IS NOT NULL ORDER BY display_name',
  ));
  const out: ScheduleKindDto[] = [];
  for (const w of widgets) {
    const type = String(w.type);
    const loaded = await loadWidgetSpec(type).catch(() => null);
    if (!loaded) continue;
    for (const kind of loaded.spec.schedules ?? []) {
      const run = describeRun(loaded, kind);
      if (!run) continue;
      // A limited grant may still cover some stacks/containers; the dialog asks for one.
      const resources = (run.targetKind || run.targetKindParam) ? await permittedResources(viewer, run.permission, serverId) : [];
      const allowed = await hasPermission(viewer, run.permission, serverId)
        || (Array.isArray(resources) && resources.length > 0);
      if (!allowed) continue;
      out.push({
        widget_type: type,
        widget_name: String(w.display_name ?? type),
        package_id: loaded.packageId,
        id: kind.id,
        label: kind.label,
        ...(kind.description ? { description: kind.description } : {}),
        target: kind.target ?? 'server',
        run: 'dataset' in kind.run ? 'dataset' : 'action',
      });
    }
  }
  return out;
}
