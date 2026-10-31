/**
 * Jobs of package widgets: the database side. A job is one run of a long-running script action; its record lives in
 * `package_jobs` so it survives a restart and every node can show it. Only the node that started a job runs it; others
 * only read the record, and ask for a cancel by setting a flag the running node checks.
 */
import crypto from 'crypto';
import os from 'os';
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';

export type JobStatus = 'running' | 'success' | 'error' | 'cancelled' | 'lost';

/** A running job nobody has updated for this long is `lost` (its node went away). */
export const JOB_STALE_MS = 90_000;
export const KEEP_FINISHED_MS = 7 * 24 * 3600 * 1000;

export class JobConflictError extends Error {
  constructor() { super('A job is already running for this widget on this server'); }
}

export interface JobRecord {
  id: string;
  packageId: string;
  widgetType: string;
  actionId: string;
  serverId: string;
  userId: string | null;
  status: JobStatus;
  params: Record<string, unknown>;
  steps: string[];
  percent: number | null;
  message: string | null;
  cancelRequested: boolean;
  node: string | null;
  startedAt: number;
  updatedAt: number;
  finishedAt: number | null;
  /** The widget (instance) the action was started from, the output of the script (secrets removed), and whether the screen can be reopened. */
  widgetId: string | null;
  log: string;
  hasOrigin: boolean;
}

/** What the browser and API clients see of a job (no parameters, no node). */
export interface JobView {
  id: string;
  actionId: string;
  status: JobStatus;
  steps: string[];
  percent: number | null;
  message: string | null;
  cancelRequested: boolean;
  startedAt: number;
  updatedAt: number;
  finishedAt: number | null;
}

export const nodeName = (): string => process.env.BOSUN_NODE_ID || os.hostname();

/** How much of a job's output is kept. */
export const LOG_KEEP = 64 * 1024;

/** Parameters as they are recorded with a job: text parameters (settings, a compose file) are not copied there, only their size. */
function redactParams(params: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(params).map(([k, v]) => [k, typeof v === 'string' && (v.length > 200 || v.includes('\n')) ? `(${v.length} characters)` : v]));
}

/** The newest jobs, any server, for the notification area. */
export async function recentJobs(limit = 30, now = Date.now()): Promise<JobRecord[]> {
  await expireLostJobs(now);
  return rowsToObjects(await rqlite.query('SELECT * FROM package_jobs ORDER BY started_at DESC LIMIT ?', [limit])).map(toRecord);
}

/** The encrypted origin of a job (see origin.ts). */
export async function getOriginEnc(id: string): Promise<string | null> {
  const r = rowsToObjects(await rqlite.query('SELECT origin_enc FROM package_jobs WHERE id = ?', [id]))[0];
  return r?.origin_enc ? String(r.origin_enc) : null;
}

function parseJson<T>(raw: unknown, fallback: T): T {
  try { const v = JSON.parse(String(raw ?? '')); return v ?? fallback; } catch { return fallback; }
}

function toRecord(r: Record<string, unknown>): JobRecord {
  return {
    id: String(r.id), packageId: String(r.package_id), widgetType: String(r.widget_type), actionId: String(r.action_id), serverId: String(r.server_id),
    userId: r.user_id ? String(r.user_id) : null, status: String(r.status) as JobStatus, params: parseJson(r.params, {}),
    steps: parseJson<string[]>(r.steps, []), percent: r.percent === null || r.percent === undefined ? null : Number(r.percent),
    message: r.message === null || r.message === undefined ? null : String(r.message), cancelRequested: Number(r.cancel_requested) === 1,
    node: r.node ? String(r.node) : null, startedAt: Number(r.started_at), updatedAt: Number(r.updated_at), finishedAt: r.finished_at ? Number(r.finished_at) : null,
    widgetId: r.widget_id ? String(r.widget_id) : null, log: r.log ? String(r.log) : '', hasOrigin: !!r.origin_enc,
  };
}

export const viewOf = (j: JobRecord): JobView => ({
  id: j.id, actionId: j.actionId, status: j.status, steps: j.steps, percent: j.percent, message: j.message,
  cancelRequested: j.cancelRequested, startedAt: j.startedAt, updatedAt: j.updatedAt, finishedAt: j.finishedAt,
});

/** Mark running jobs whose heartbeat stopped as lost, so they do not block the widget for ever. */
export async function expireLostJobs(now = Date.now()): Promise<void> {
  await rqlite.execute(
    `UPDATE package_jobs SET status = 'lost', message = ?, finished_at = ?, updated_at = ? WHERE status = 'running' AND updated_at < ?`,
    ['Bosun lost track of this job (the node running it stopped). The work on the host may or may not have finished.', now, now, now - JOB_STALE_MS]);
}

/** Forget finished jobs after a week. */
export async function pruneJobs(now = Date.now()): Promise<void> {
  await rqlite.execute(`DELETE FROM package_jobs WHERE status != 'running' AND finished_at IS NOT NULL AND finished_at < ?`, [now - KEEP_FINISHED_MS]);
}

export interface NewJob { packageId: string; widgetType: string; actionId: string; serverId: string; userId: string | null; params: Record<string, unknown>; widgetId?: string | null; originEnc?: string | null }

/** Create a running job, or throw JobConflictError when the widget already has one on this server. */
export async function createJob(input: NewJob, now = Date.now()): Promise<JobRecord> {
  await expireLostJobs(now);
  const id = crypto.randomUUID();
  try {
    await rqlite.execute(
      `INSERT INTO package_jobs (id, package_id, widget_type, action_id, server_id, user_id, status, params, steps, percent, message, cancel_requested, node, started_at, updated_at, widget_id, origin_enc)
       VALUES (?, ?, ?, ?, ?, ?, 'running', ?, '[]', NULL, NULL, 0, ?, ?, ?, ?, ?)`,
      [id, input.packageId, input.widgetType, input.actionId, input.serverId, input.userId, JSON.stringify(redactParams(input.params)).slice(0, 4000), nodeName(), now, now, input.widgetId ?? null, input.originEnc ?? null]);
  } catch (err) {
    if (/UNIQUE constraint failed/i.test(String(err instanceof Error ? err.message : err))) throw new JobConflictError();
    throw err;
  }
  void pruneJobs(now).catch(() => undefined);
  return { id, packageId: input.packageId, widgetType: input.widgetType, actionId: input.actionId, serverId: input.serverId, userId: input.userId, params: input.params, status: 'running', steps: [], percent: null, message: null, cancelRequested: false, node: nodeName(), startedAt: now, updatedAt: now, finishedAt: null, widgetId: input.widgetId ?? null, log: '', hasOrigin: !!input.originEnc };
}

export async function getJob(id: string): Promise<JobRecord | null> {
  const r = rowsToObjects(await rqlite.query('SELECT * FROM package_jobs WHERE id = ?', [id]))[0];
  return r ? toRecord(r) : null;
}

/** The newest job of a widget type on a server (running or finished), after marking lost ones. */
export async function latestJob(serverId: string, widgetType: string, now = Date.now()): Promise<JobRecord | null> {
  await expireLostJobs(now);
  const r = rowsToObjects(await rqlite.query('SELECT * FROM package_jobs WHERE server_id = ? AND widget_type = ? ORDER BY started_at DESC LIMIT 1', [serverId, widgetType]))[0];
  return r ? toRecord(r) : null;
}

/** Heartbeat and progress of a running job; answers whether a cancel was requested. */
export async function reportProgress(id: string, p: { steps: string[]; percent: number | null; message?: string | null; log?: string }, now = Date.now()): Promise<{ cancelRequested: boolean; stillRunning: boolean }> {
  await rqlite.execute(
    `UPDATE package_jobs SET steps = ?, percent = ?, message = COALESCE(?, message), log = COALESCE(?, log), updated_at = ? WHERE id = ? AND status = 'running'`,
    [JSON.stringify(p.steps.slice(-50)), p.percent, p.message ?? null, p.log === undefined ? null : p.log.slice(-LOG_KEEP), now, id]);
  const r = rowsToObjects(await rqlite.query('SELECT status, cancel_requested FROM package_jobs WHERE id = ?', [id]))[0];
  return { cancelRequested: !!r && Number(r.cancel_requested) === 1, stillRunning: !!r && r.status === 'running' };
}

/** Finish a running job. A job that is no longer running (cancelled or lost meanwhile) keeps its status. */
export async function finishJob(id: string, status: Exclude<JobStatus, 'running'>, p: { steps: string[]; percent: number | null; message: string; log?: string }, now = Date.now()): Promise<void> {
  await rqlite.execute(
    `UPDATE package_jobs SET status = ?, steps = ?, percent = ?, message = ?, log = COALESCE(?, log), finished_at = ?, updated_at = ? WHERE id = ? AND status = 'running'`,
    [status, JSON.stringify(p.steps.slice(-50)), p.percent, p.message.slice(0, 500), p.log === undefined ? null : p.log.slice(-LOG_KEEP), now, now, id]);
}

/** Ask for a cancel; the node running the job notices at its next heartbeat. False when the job is not running. */
export async function requestCancel(id: string): Promise<boolean> {
  const j = await getJob(id);
  if (!j || j.status !== 'running') return false;
  await rqlite.execute(`UPDATE package_jobs SET cancel_requested = 1 WHERE id = ? AND status = 'running'`, [id]);
  return true;
}
