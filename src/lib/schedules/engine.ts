/**
 * The schedule engine: the cluster leader runs the schedules widget packages declare.
 *
 * Every 60 s the leader looks for schedules whose `next_run_at` has passed. It claims each one with a compare-and-set
 * on `next_run_at` (so two nodes, or two ticks, never run the same occurrence) and records one `schedule_runs` row per
 * attempt. A run acts as the person or API key that created the schedule: their principal is rebuilt on every run and
 * their permission for the server (and stack/container) is checked again, together with the permission the widget
 * declared for the dataset or action. If any of that is gone the schedule pauses, with one bell notice.
 *
 * Dataset runs count the rows that match the kind's `notify.when` and raise one notice per schedule per day. Action
 * runs go through `runWidgetAction`, so they are ordinary jobs with tasks, audit, cancel and "started by"; a job's
 * outcome is followed in the background.
 */
import crypto from 'crypto';
import type { TokenPayload } from '@/lib/auth/jwt';
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';
import { logAudit } from '@/lib/audit/logger';
import { notify } from '@/lib/notifications/store';
import { hasPermission } from '@/lib/permissions/authorize';
import { requesterPayload } from '@/lib/access/requester';
import { loadDataset, loadWidgetSpec } from '@/lib/widgets/runtime/execute';
import { runWidgetAction } from '@/lib/widgets/runtime/run-action';
import { filterRows, resolveTarget, viewFilter } from '@/lib/widgets/runtime/resource-check';
import { getJob } from '@/lib/widgets/jobs/store';
import { nextRun } from './cron';
import {
  actionParams, countMatching, datasetArgs, describeRun, noticeFor, parseOptions, pauseKey, planDueRun, rowsOf,
  type ScheduleRow, type ScheduleRunDto,
} from './model';

const LINK = '/settings/schedules';
const DEFAULT_KEEP_RUNS = 200;
const JOB_WATCH_MS = 30 * 60_000;
const JOB_POLL_MS = 5_000;

export interface RunOutcome {
  started: boolean;
  runId?: string;
  status?: ScheduleRunDto['status'];
  message?: string;
  jobId?: string;
  matchedCount?: number;
}

const nowIso = () => new Date().toISOString();

async function isLeader(): Promise<boolean> {
  try {
    const s = await rqlite.getStatus();
    return s?.store?.raft?.state === 'Leader';
  } catch {
    return false;
  }
}

/**
 * Claim one occurrence with a compare-and-set: only a caller that still sees `expectedNextAt` wins, so a second
 * node (or a later tick) that read the same row cannot run it too.
 */
export async function claimSchedule(id: string, expectedNextAt: string, nextAt: string, at: string): Promise<boolean> {
  const r = await rqlite.execute(
    `UPDATE schedules SET next_run_at = ?, updated_at = ? WHERE id = ? AND next_run_at = ? AND enabled = 1 AND paused_reason IS NULL`,
    [nextAt, at, id, expectedNextAt],
  );
  return Number(r.rows_affected) === 1;
}

/** Insert a `running` row, but only when this schedule has no run in progress. Returns the run id, or null. */
export async function startRunRow(scheduleId: string, at = nowIso()): Promise<string | null> {
  const id = crypto.randomUUID();
  try {
    const r = await rqlite.execute(
      `INSERT INTO schedule_runs (id, schedule_id, started_at, status)
       SELECT ?, ?, ?, 'running'
       WHERE NOT EXISTS (SELECT 1 FROM schedule_runs WHERE schedule_id = ? AND status = 'running')`,
      [id, scheduleId, at, scheduleId],
    );
    return Number(r.rows_affected) === 1 ? id : null;
  } catch {
    // The partial unique index lost a race with another caller; the other run owns the schedule.
    return null;
  }
}

async function finishRun(runId: string, status: ScheduleRunDto['status'], message: string | null, extra: { jobId?: string | null; matchedCount?: number | null } = {}): Promise<void> {
  await rqlite.execute(
    'UPDATE schedule_runs SET finished_at = ?, status = ?, message = ?, job_id = COALESCE(?, job_id), matched_count = ? WHERE id = ?',
    [nowIso(), status, message ? message.slice(0, 1000) : null, extra.jobId ?? null, extra.matchedCount ?? null, runId],
  );
}

async function pruneRuns(scheduleId: string, keep: number): Promise<void> {
  await rqlite.execute(
    `DELETE FROM schedule_runs WHERE schedule_id = ? AND status != 'running'
       AND id NOT IN (SELECT id FROM schedule_runs WHERE schedule_id = ? ORDER BY started_at DESC LIMIT ?)`,
    [scheduleId, scheduleId, keep],
  ).catch(() => undefined);
}

function resourceOf(row: ScheduleRow): { kind: 'stack' | 'container'; name: string } | null {
  return row.resource_kind === 'stack' || row.resource_kind === 'container' ? { kind: row.resource_kind, name: row.resource_name } : null;
}

async function serverName(serverId: string): Promise<string> {
  const r = await rqlite.query('SELECT name FROM servers WHERE id = ?', [serverId]);
  return r.values?.[0]?.[0] ? String(r.values[0][0]) : 'a server';
}

/** Pause a schedule with one bell notice (deduped per day) and an audit entry. Never throws. */
async function pause(row: ScheduleRow, reason: string, opts: { userId?: string; ip?: string } = {}): Promise<void> {
  const at = nowIso();
  try {
    await rqlite.execute(
      'UPDATE schedules SET enabled = 0, paused_reason = ?, next_run_at = NULL, updated_at = ? WHERE id = ?',
      [reason.slice(0, 500), at, row.id],
    );
    await notify({
      kind: 'alert', severity: 'warning', audience: 'admin', link: LINK,
      title: `Schedule paused: ${row.name}`.slice(0, 200),
      message: reason.slice(0, 2000),
      serverId: row.server_id, dedupeKey: pauseKey(row.id, reason, new Date(at)),
      data: { scheduleId: row.id },
    });
    await logAudit({
      userId: opts.userId, serverId: row.server_id, action: 'schedule.pause', category: 'schedules',
      status: 'failure', ipAddress: opts.ip,
      details: JSON.stringify({ schedule: row.id, reason }).slice(0, 900),
    });
  } catch (err) {
    console.warn(`[schedules] could not pause ${row.id}: ${err instanceof Error ? err.message : err}`);
  }
}

async function notifyFailure(row: ScheduleRow, runId: string, message: string): Promise<void> {
  await notify({
    kind: 'alert', severity: 'warning', audience: 'admin', link: LINK,
    title: `Scheduled run failed: ${row.name}`.slice(0, 200),
    message: message.slice(0, 2000), serverId: row.server_id,
    dedupeKey: `schedule-failed:${runId}`, data: { scheduleId: row.id, runId },
  });
}

async function auditRun(row: ScheduleRow, userId: string | undefined, status: 'success' | 'failure' | 'pending', details: Record<string, unknown>, ip?: string): Promise<void> {
  await logAudit({
    userId, serverId: row.server_id, action: 'schedule.execute', category: 'schedules',
    status, ipAddress: ip, details: JSON.stringify({ schedule: row.id, kind: row.schedule_kind, ...details }).slice(0, 900),
  });
}

/** Follow a job started by an action run until it finishes, then record its outcome. Never throws. */
async function watchJob(runId: string, jobId: string, row: ScheduleRow): Promise<void> {
  const until = Date.now() + JOB_WATCH_MS;
  while (Date.now() < until) {
    await new Promise(res => setTimeout(res, JOB_POLL_MS));
    const job = await getJob(jobId).catch(() => null);
    if (!job || job.status === 'running') continue;
    const ok = job.status === 'success';
    const message = job.message || `Job ${job.status}`;
    await finishRun(runId, ok ? 'success' : 'failed', message, { jobId });
    if (!ok) await notifyFailure(row, runId, message);
    await auditRun(row, job.userId ?? undefined, ok ? 'success' : 'failure', { run: runId, job: jobId, outcome: job.status, message });
    await pruneRuns(row.id, parseOptions(row.options).keepRuns ?? DEFAULT_KEEP_RUNS);
    return;
  }
  await finishRun(runId, 'failed', `The job did not finish within ${Math.round(JOB_WATCH_MS / 60_000)} minutes`, { jobId });
  await notifyFailure(row, runId, `The job did not finish within ${Math.round(JOB_WATCH_MS / 60_000)} minutes`);
  await pruneRuns(row.id, parseOptions(row.options).keepRuns ?? DEFAULT_KEEP_RUNS);
}

/**
 * Run one schedule now: claim a run row, re-check the creator's rights, then run the dataset or action. Used by the
 * engine tick and by "Run now". Returns at once for a job action (its outcome is recorded when the job ends).
 */
export async function executeScheduleRun(scheduleId: string, opts: { trigger: 'schedule' | 'manual'; actor?: TokenPayload; ip?: string } = { trigger: 'schedule' }): Promise<RunOutcome> {
  const row = rowsToObjects(await rqlite.query('SELECT * FROM schedules WHERE id = ?', [scheduleId]))[0] as unknown as ScheduleRow | undefined;
  if (!row) return { started: false, message: 'Schedule not found' };
  const runId = await startRunRow(scheduleId);
  if (!runId) return { started: false, message: 'A run of this schedule is already in progress' };
  const at = nowIso();
  await rqlite.execute('UPDATE schedules SET last_run_at = ?, updated_at = ? WHERE id = ?', [at, at, scheduleId]).catch(() => undefined);

  try {
    const requester = await requesterPayload(row.created_by_type, row.created_by_id);
    if (!requester) {
      const reason = `The ${row.created_by_type === 'api_key' ? 'API key' : 'user'} that created this schedule no longer exists or is disabled, so it cannot run as them.`;
      await pause(row, reason, { ip: opts.ip });
      await finishRun(runId, 'skipped', reason);
      await auditRun(row, undefined, 'failure', { run: runId, reason });
      return { started: true, runId, status: 'skipped', message: reason };
    }
    if (!(await hasPermission(requester, 'schedules.manage', row.server_id))) {
      const reason = `${requester.username} no longer holds "Manage schedules" on this server, so the schedule cannot run as them.`;
      await pause(row, reason, { userId: requester.userId, ip: opts.ip });
      await finishRun(runId, 'skipped', reason);
      await auditRun(row, requester.userId, 'failure', { run: runId, reason });
      return { started: true, runId, status: 'skipped', message: reason };
    }

    const loaded = await loadWidgetSpec(row.widget_type);
    const kind = loaded?.spec.schedules?.find(k => k.id === row.schedule_kind);
    const run = loaded && kind ? describeRun(loaded, kind) : null;
    if (!loaded || !kind || !run) {
      const reason = 'The widget no longer offers this schedule kind (was it removed or updated?).';
      await pause(row, reason, { userId: requester.userId, ip: opts.ip });
      await finishRun(runId, 'skipped', reason);
      await auditRun(row, requester.userId, 'failure', { run: runId, reason });
      return { started: true, runId, status: 'skipped', message: reason };
    }

    const resource = resourceOf(row);
    if (Boolean(resource) !== Boolean(run.targetKind)) {
      const reason = resource
        ? 'The widget changed this schedule kind so it no longer runs for one stack or container.'
        : 'The widget changed this schedule kind to run for one stack or container, but this schedule names none.';
      await pause(row, reason, { userId: requester.userId, ip: opts.ip });
      await finishRun(runId, 'skipped', reason);
      await auditRun(row, requester.userId, 'failure', { run: runId, reason });
      return { started: true, runId, status: 'skipped', message: reason };
    }
    const ctx = resource && run.targetKind ? await resolveTarget(row.server_id, loaded, { kind: run.targetKind, param: run.targetParam ?? '' }, resource.name).catch(() => null) : null;
    if (!(await hasPermission(requester, run.permission, row.server_id, ctx))) {
      const reason = `${requester.username} no longer holds the permission this schedule needs (${run.permission}) on ${resource ? `${resource.kind} ${resource.name}` : 'this server'}, so it cannot run as them.`;
      await pause(row, reason, { userId: requester.userId, ip: opts.ip });
      await finishRun(runId, 'skipped', reason);
      await auditRun(row, requester.userId, 'failure', { run: runId, reason });
      return { started: true, runId, status: 'skipped', message: reason };
    }

    const stored = parseOptions(row.options);

    if ('dataset' in kind.run) {
      const args = datasetArgs(kind, stored, resource?.name ?? null, run.targetParam);
      // Fill the script's own declared defaults, exactly like a screen loading the dataset.
      for (const [name, spec] of Object.entries(run.params) as Array<[string, { default?: string | number | boolean }]>) if (args[name] === undefined && spec.default !== undefined) args[name] = spec.default;
      const view = await viewFilter(requester, run.permission, row.server_id, run.dataset?.resources);
      if (!view) {
        const reason = `${requester.username} may no longer see this data on the server, so the schedule cannot run as them.`;
        await pause(row, reason, { userId: requester.userId, ip: opts.ip });
        await finishRun(runId, 'skipped', reason);
        await auditRun(row, requester.userId, 'failure', { run: runId, reason });
        return { started: true, runId, status: 'skipped', message: reason };
      }
      const answer = await loadDataset(row.server_id, loaded, kind.run.dataset, args);
      const data = view === 'all' ? answer.data : filterRows(answer.data, run.dataset?.resources ?? {}, view);
      const rows = rowsOf(data);
      const matched = countMatching(rows, kind.notify?.when);
      let message = `${rows.length} row${rows.length === 1 ? '' : 's'} read, ${matched} matched`;
      if (kind.notify && matched > 0) {
        const notice = noticeFor(row, kind.notify, matched, await serverName(row.server_id), new Date(at));
        const fresh = await notify({
          kind: 'alert', severity: notice.severity, audience: 'admin', link: LINK,
          title: notice.title, message: notice.message, serverId: row.server_id,
          dedupeKey: notice.dedupeKey, data: { scheduleId: row.id, count: matched },
        });
        message += fresh ? '; one notice raised' : '; a notice for today was already raised';
      }
      await finishRun(runId, 'success', message, { matchedCount: matched });
      await auditRun(row, requester.userId, 'success', { run: runId, rows: rows.length, matched });
      await pruneRuns(row.id, stored.keepRuns ?? DEFAULT_KEEP_RUNS);
      return { started: true, runId, status: 'success', message, matchedCount: matched };
    }

    const params = actionParams(kind, stored, resource?.name ?? null, run.targetParam);
    if (!run.action) {
      const reason = 'The widget no longer offers this action.';
      await pause(row, reason, { userId: requester.userId, ip: opts.ip });
      await finishRun(runId, 'skipped', reason);
      return { started: true, runId, status: 'skipped', message: reason };
    }
    const res = await runWidgetAction(requester, row.server_id, loaded, run.action, { params, confirm: true }, { ip: opts.ip });
    const json = await res.json().catch(() => null) as { data?: { jobId?: string; status?: string; success?: boolean; message?: string; output?: string }; error?: { message?: string } } | null;
    if (res.status >= 400) {
      const message = json?.error?.message || `The action failed (HTTP ${res.status})`;
      await finishRun(runId, 'failed', message);
      await notifyFailure(row, runId, message);
      await auditRun(row, requester.userId, 'failure', { run: runId, error: message });
      return { started: true, runId, status: 'failed', message };
    }
    const jobId = json?.data?.jobId;
    if (jobId) {
      const message = `Job ${jobId} started`;
      // Keep the run "running" until the job ends, so the schedule cannot start a second one meanwhile.
      await rqlite.execute('UPDATE schedule_runs SET job_id = ?, message = ? WHERE id = ?', [jobId, message, runId]);
      await auditRun(row, requester.userId, 'pending', { run: runId, job: jobId, started: true });
      void watchJob(runId, jobId, row);
      return { started: true, runId, status: 'running', message, jobId };
    }
    const ok = json?.data?.success !== false;
    const message = json?.data?.message || (ok ? 'The action finished' : 'The action reported a failure');
    await finishRun(runId, ok ? 'success' : 'failed', message);
    if (!ok) await notifyFailure(row, runId, message);
    await auditRun(row, requester.userId, ok ? 'success' : 'failure', { run: runId, message });
    await pruneRuns(row.id, stored.keepRuns ?? DEFAULT_KEEP_RUNS);
    return { started: true, runId, status: ok ? 'success' : 'failed', message };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await finishRun(runId, 'failed', message).catch(() => undefined);
    await notifyFailure(row, runId, message).catch(() => undefined);
    await auditRun(row, undefined, 'failure', { run: runId, error: message }).catch(() => undefined);
    return { started: true, runId, status: 'failed', message };
  }
}

/** One engine tick: claim every due schedule on the leader and start its run. */
export async function tickSchedules(now = new Date()): Promise<number> {
  if (!(await isLeader())) return 0;
  // A node that died mid-run leaves a "running" row behind; it must not block the schedule forever.
  await rqlite.execute(
    "UPDATE schedule_runs SET status = 'failed', finished_at = ?, message = COALESCE(message, 'The run did not finish (the node restarted)') WHERE status = 'running' AND started_at < ?",
    [nowIso(), new Date(now.getTime() - 24 * 3_600_000).toISOString()],
  ).catch(() => undefined);
  const due = rowsToObjects(await rqlite.query(
    'SELECT id, cron, timezone, next_run_at FROM schedules WHERE enabled = 1 AND paused_reason IS NULL AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at LIMIT 50',
    [now.toISOString()],
  ));
  let started = 0;
  for (const raw of due) {
    const row = raw as unknown as Pick<ScheduleRow, 'id' | 'cron' | 'timezone' | 'next_run_at'>;
    if (!row.next_run_at) continue;
    // One run per schedule at a time: leave it due and look again next tick.
    const running = await rqlite.query("SELECT 1 FROM schedule_runs WHERE schedule_id = ? AND status = 'running' LIMIT 1", [row.id]).catch(() => null);
    if (running?.values?.length) continue;
    const plan = planDueRun(row.cron, row.timezone, row.next_run_at, now);
    if (!plan) {
      // A cron or time zone this build cannot read: stop trying every minute.
      const full = rowsToObjects(await rqlite.query('SELECT * FROM schedules WHERE id = ?', [row.id]))[0] as unknown as ScheduleRow | undefined;
      if (full) await pause(full, 'This schedule has a cron expression or time zone that cannot be read.', {});
      continue;
    }
    if (!(await claimSchedule(row.id, row.next_run_at, plan.nextAt, now.toISOString()))) continue;
    if (plan.missed) {
      const runId = await startRunRow(row.id, now.toISOString());
      if (runId) await finishRun(runId, 'skipped', `Skipped: the cluster was down for more than one interval (${Math.round(plan.lateMs / 60_000)} minutes late).`);
      continue;
    }
    started++;
    void executeScheduleRun(row.id, { trigger: 'schedule' }).catch(err => {
      console.warn(`[schedules] run of ${row.id} failed: ${err instanceof Error ? err.message : err}`);
    });
  }
  return started;
}

/** Start the 60 s loop (leader only), once per process. */
export function startScheduleEngine(): void {
  const g = globalThis as unknown as { __bosunScheduleTimer?: NodeJS.Timeout };
  if (g.__bosunScheduleTimer || process.env.BOSUN_SCHEDULES === '0') return;
  setTimeout(() => { void tickSchedules().catch(err => console.warn('[schedules] tick failed:', err instanceof Error ? err.message : err)); }, 45_000);
  g.__bosunScheduleTimer = setInterval(() => {
    void tickSchedules().catch(err => console.warn('[schedules] tick failed:', err instanceof Error ? err.message : err));
  }, 60_000);
}

/** Recompute a schedule's next run (used when it is resumed or its timetable changes). */
export function nextRunAt(cron: string, timezone: string, from = new Date()): string | null {
  return nextRun(cron, timezone, from)?.toISOString() ?? null;
}
