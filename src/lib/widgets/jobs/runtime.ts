/**
 * Running a long-running script action as a job (spec version 2, `job: true`).
 *
 * The node that receives the request starts the script, reads its output as it arrives (the generic protocol: `[step]`,
 * `PROGRESS`, `DONE`, `ERROR:`), and writes steps and progress to the job's record every second or two. That write is
 * also a heartbeat and the place where a cancel asked for on any node is noticed. When the script ends, the record gets its
 * final status. Nothing here knows what the widget is.
 */
import { logAudit, AuditActions } from '@/lib/audit/logger';
import { runScript, cancelScript, RuntimeError, type LoadedSpec, type PreparedScript } from '@/lib/widgets/runtime/execute';
import { parseScriptOutput } from '@/lib/widgets/runtime/script-run';
import { storeActionData } from '@/lib/widgets/runtime/store-data';
import { rqlite } from '@/lib/db/rqlite-client';
import type { ActionSpec } from '@/lib/widgets/runtime/spec';
import { createJob, finishJob, getJob, JobConflictError, reportProgress, requestCancel, type JobRecord, type JobStatus } from '@/lib/widgets/jobs/store';

/** How often a running job reports its progress (changed by tests only). */
export const timing = { flushMs: 1500 };
const MAX_BUFFER = 256 * 1024;

interface Running { controller: AbortController; cancel: () => Promise<void> }
const g = globalThis as unknown as { __bosunRunningJobs?: Map<string, Running> };
const running = g.__bosunRunningJobs ?? (g.__bosunRunningJobs = new Map());

export interface StartedJob { job: JobRecord }

export interface StartJobInput {
  serverId: string;
  loaded: LoadedSpec;
  action: ActionSpec;
  prepared: PreparedScript;
  userId: string | null;
  params: Record<string, unknown>;
  /** The widget (instance) whose settings the action reads, when it names one. */
  instanceId?: string;
  ip?: string;
}

/** What the final status and message of a finished script are. */
export function outcomeOf(r: { exitCode: number; timedOut: boolean; aborted?: boolean; stdout: string; stderr: string }): { status: Exclude<JobStatus, 'running' | 'lost'>; message: string } {
  const p = parseScriptOutput(r.stdout);
  if (r.aborted) return { status: 'cancelled', message: 'Cancelled' };
  if (r.timedOut) return { status: 'error', message: 'It took too long and was stopped' };
  if (r.exitCode === 0 && !p.error) return { status: 'success', message: p.done || 'Done' };
  const tail = (r.stderr.trim() || p.lines.slice(-3).join(' ')).slice(0, 300);
  return { status: 'error', message: p.error || tail || `Failed (exit ${r.exitCode})` };
}

/** What a successful job does besides finishing: store its output as the widget's data, and/or ask for a fresh collection. */
async function afterSuccess(input: StartJobInput, stdout: string): Promise<void> {
  const { serverId, loaded, action } = input;
  try {
    if (action.stores === 'data') await storeActionData(serverId, loaded.type, loaded.spec.data, input.instanceId, stdout);
    if (action.after === 'refresh') await rqlite.execute('UPDATE servers SET poll_requested_at = ? WHERE id = ?', [Date.now(), serverId]);
  } catch { /* the job itself succeeded; the next collection brings the data up to date */ }
}

/** Start the job and return at once; the script runs in the background of this process. */
export async function startJob(input: StartJobInput): Promise<StartedJob> {
  const { serverId, loaded, action, prepared } = input;
  let job: JobRecord;
  try {
    job = await createJob({ packageId: loaded.packageId, widgetType: loaded.type, actionId: action.id, serverId, userId: input.userId, params: input.params });
  } catch (err) {
    if (err instanceof JobConflictError) throw new RuntimeError(err.message, 409, 'JOB_RUNNING');
    throw err;
  }
  const controller = new AbortController();
  const cancel = async () => {
    if (controller.signal.aborted) return;
    controller.abort();
    // Closing the channel is not enough for a script that keeps running: stop it (and what it started) on the host too.
    await cancelScript(serverId, loaded, prepared.scriptId, job.id).catch(() => undefined);
  };
  running.set(job.id, { controller, cancel });
  void run(job, input, controller, cancel);
  return { job };
}

async function run(job: JobRecord, input: StartJobInput, controller: AbortController, cancel: () => Promise<void>): Promise<void> {
  const { serverId, loaded, action, prepared } = input;
  let out = '';
  let dirty = false;
  const snapshot = () => {
    const p = parseScriptOutput(out);
    return { steps: p.steps, percent: p.progress ? p.progress.percent : null };
  };
  const flush = async () => {
    dirty = false;
    try {
      const s = snapshot();
      const r = await reportProgress(job.id, s);
      if ((r.cancelRequested || !r.stillRunning) && !controller.signal.aborted) void cancel();
    } catch { /* the database is briefly unavailable: the next tick tries again */ }
  };
  const timer = setInterval(() => { void flush(); }, timing.flushMs);
  let status: Exclude<JobStatus, 'running'> = 'error';
  let message = 'Failed';
  try {
    const r = await runScript(serverId, loaded, prepared.scriptId, prepared.args, {
      jobId: job.id,
      signal: controller.signal,
      onData: (text, isErr) => { if (!isErr && out.length < MAX_BUFFER) { out += text; dirty = true; } },
    });
    ({ status, message } = outcomeOf(r));
    if (!out) out = r.stdout;
    if (status === 'success') await afterSuccess(input, r.stdout);
  } catch (err) {
    status = 'error';
    message = err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300);
  } finally {
    clearInterval(timer);
    running.delete(job.id);
  }
  const s = snapshot();
  await finishJob(job.id, status, { steps: s.steps, percent: status === 'success' ? 100 : s.percent, message }).catch(() => undefined);
  const final = await getJob(job.id).catch(() => null);
  await logAudit({
    userId: input.userId ?? undefined, serverId, action: AuditActions.WIDGET_ACTION, status: status === 'success' ? 'success' : 'failure',
    details: JSON.stringify({ widget: loaded.type, action: action.id, job: job.id, finished: final?.status ?? status, message }).slice(0, 900), ipAddress: input.ip,
  }).catch(() => undefined);
}

/**
 * Cancel a job. On the node that runs it the script is stopped at once; on any other node the flag in the database makes
 * the running node do it at its next heartbeat. False when the job is not running.
 */
export async function cancelJob(jobId: string): Promise<boolean> {
  const local = running.get(jobId);
  const ok = await requestCancel(jobId);
  if (local) void local.cancel();
  return ok;
}

/** Test hook: how many jobs this process is running. */
export const runningJobCount = (): number => running.size;
