import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---- an in-memory package_jobs table answering the statements the job store makes ----------------------------------
type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[] }));
const audits = vi.hoisted(() => ({ list: [] as Record<string, unknown>[] }));
const scripts = vi.hoisted(() => ({
  run: null as null | ((args: unknown, ext: { jobId?: string; signal?: AbortSignal; onData?: (t: string, e: boolean) => void }) => Promise<Record<string, unknown>>),
  cancelled: [] as string[],
}));

vi.mock('@/lib/db/rqlite-client', () => ({
  rowsToObjects: (r: { columns: string[]; values: unknown[][] }) => (r.values ?? []).map(v => Object.fromEntries(r.columns.map((c, i) => [c, v[i]]))),
  rqlite: {
    async execute(sql: string, p: unknown[] = []) {
      if (/^UPDATE package_jobs SET status = 'lost'/.test(sql.trim())) {
        const [message, finished, updated, before] = p as [string, number, number, number];
        for (const r of db.rows) if (r.status === 'running' && (r.updated_at as number) < before) Object.assign(r, { status: 'lost', message, finished_at: finished, updated_at: updated });
        return {};
      }
      if (/^DELETE FROM package_jobs/.test(sql.trim())) {
        const before = p[0] as number;
        db.rows = db.rows.filter(r => r.status === 'running' || r.finished_at === null || (r.finished_at as number) >= before);
        return {};
      }
      if (/^INSERT INTO package_jobs/.test(sql.trim())) {
        const [id, package_id, widget_type, action_id, server_id, user_id, params, node, started, updated, widget_id, origin_enc] = p as string[];
        if (db.rows.some(r => r.server_id === server_id && r.widget_type === widget_type && r.action_id === action_id && r.status === 'running')) throw new Error('rqlite execute error: UNIQUE constraint failed: package_jobs.server_id, package_jobs.widget_type, package_jobs.action_id');
        db.rows.push({ id, package_id, widget_type, action_id, server_id, user_id, status: 'running', params, steps: '[]', percent: null, message: null, cancel_requested: 0, node, started_at: Number(started), updated_at: Number(updated), finished_at: null, widget_id, origin_enc, log: null });
        return {};
      }
      if (/SET steps = \?, percent = \?, message = COALESCE/.test(sql)) {
        const [steps, percent, message, log, updated, id] = p as [string, number | null, string | null, string | null, number, string];
        const r = db.rows.find(x => x.id === id && x.status === 'running');
        if (r) Object.assign(r, { steps, percent, message: message ?? r.message, log: log ?? r.log, updated_at: updated });
        return {};
      }
      if (/SET status = \?, steps = \?/.test(sql)) {
        const [status, steps, percent, message, log, finished, updated, id] = p as [string, string, number | null, string, string | null, number, number, string];
        const r = db.rows.find(x => x.id === id && x.status === 'running');
        if (r) Object.assign(r, { status, steps, percent, message, log: log ?? r.log, finished_at: finished, updated_at: updated });
        return {};
      }
      if (/SET cancel_requested = 1/.test(sql)) {
        const r = db.rows.find(x => x.id === p[0] && x.status === 'running');
        if (r) r.cancel_requested = 1;
        return {};
      }
      throw new Error(`unexpected statement: ${sql}`);
    },
    async query(sql: string, p: unknown[] = []) {
      const cols = (rows: Row[]) => (rows[0] ? Object.keys(rows[0]) : ['id']);
      const out = (rows: Row[]) => ({ columns: cols(rows), values: rows.map(r => Object.values(r)) });
      if (/SELECT \* FROM package_jobs WHERE id = \?/.test(sql)) return out(db.rows.filter(r => r.id === p[0]));
      if (/SELECT \* FROM package_jobs WHERE server_id = \? AND widget_type = \?/.test(sql)) {
        return out(db.rows.filter(r => r.server_id === p[0] && r.widget_type === p[1]).sort((a, b) => (b.started_at as number) - (a.started_at as number)).slice(0, 1));
      }
      if (/SELECT status, cancel_requested FROM package_jobs WHERE id = \?/.test(sql)) return out(db.rows.filter(r => r.id === p[0]).map(r => ({ status: r.status, cancel_requested: r.cancel_requested })));
      throw new Error(`unexpected query: ${sql}`);
    },
  },
}));

vi.mock('@/lib/audit/logger', () => ({ AuditActions: { WIDGET_ACTION: 'widget.action' }, logAudit: async (e: Record<string, unknown>) => { audits.list.push(e); } }));
vi.mock('@/lib/widgets/runtime/execute', () => ({
  RuntimeError: class RuntimeError extends Error { status: number; code: string; constructor(m: string, s = 400, c = 'RUNTIME_ERROR') { super(m); this.status = s; this.code = c; } },
  runScript: (_s: string, _l: unknown, _id: string, args: unknown, ext: Record<string, unknown>) => scripts.run!(args, ext as never),
  cancelScript: async (_s: string, _l: unknown, _id: string, jobId: string) => { scripts.cancelled.push(jobId); },
}));

import { createJob, getJob, latestJob, reportProgress, finishJob, requestCancel, expireLostJobs, JobConflictError, viewOf, JOB_STALE_MS, KEEP_FINISHED_MS } from './store';
import { startJob, cancelJob, outcomeOf, timing, runningJobCount } from './runtime';

const input = { packageId: 'pkg', widgetType: 'demo', actionId: 'go', serverId: 's1', userId: 'u1', params: { a: 1 } };
beforeEach(() => { db.rows = []; audits.list = []; scripts.run = null; scripts.cancelled = []; timing.flushMs = 20; });

describe('the job store', () => {
  it('creates a running job and finds it again', async () => {
    const j = await createJob(input, 1000);
    expect(j).toMatchObject({ status: 'running', steps: [], percent: null, cancelRequested: false });
    expect((await getJob(j.id))?.params).toEqual({ a: 1 });
    expect((await latestJob('s1', 'demo', 1000))?.id).toBe(j.id);
    expect(await latestJob('s1', 'other', 1000)).toBeNull();
    expect(await getJob('nope')).toBeNull();
  });

  it('allows one running job per widget type, server and action, but not across different ones', async () => {
    await createJob(input, 1000);
    await expect(createJob(input, 1100)).rejects.toBeInstanceOf(JobConflictError);
    await createJob({ ...input, serverId: 's2' }, 1100);
    await createJob({ ...input, widgetType: 'other' }, 1100);
  });

  it('frees the widget when the job finishes, and keeps the first outcome', async () => {
    const j = await createJob(input, 1000);
    await finishJob(j.id, 'success', { steps: ['a'], percent: 100, message: 'Done' }, 2000);
    await finishJob(j.id, 'error', { steps: [], percent: null, message: 'late' }, 3000);
    expect(await getJob(j.id)).toMatchObject({ status: 'success', message: 'Done', percent: 100, finishedAt: 2000 });
    await createJob(input, 4000);
  });

  it('records progress as a heartbeat and answers whether a cancel was asked for', async () => {
    const j = await createJob(input, 1000);
    expect(await reportProgress(j.id, { steps: ['one'], percent: 30 }, 1500)).toEqual({ cancelRequested: false, stillRunning: true });
    expect(await requestCancel(j.id)).toBe(true);
    expect(await reportProgress(j.id, { steps: ['one', 'two'], percent: 60 }, 2000)).toEqual({ cancelRequested: true, stillRunning: true });
    expect(await getJob(j.id)).toMatchObject({ steps: ['one', 'two'], percent: 60, updatedAt: 2000, cancelRequested: true });
  });

  it('cannot cancel a job that is not running', async () => {
    const j = await createJob(input, 1000);
    await finishJob(j.id, 'success', { steps: [], percent: 100, message: 'ok' });
    expect(await requestCancel(j.id)).toBe(false);
    expect(await requestCancel('nope')).toBe(false);
  });

  it('marks a job lost when its heartbeat stops, which frees the widget', async () => {
    const j = await createJob(input, 1000);
    await reportProgress(j.id, { steps: [], percent: 10 }, 1000);
    await expireLostJobs(1000 + JOB_STALE_MS - 1);
    expect((await getJob(j.id))?.status).toBe('running');
    await expireLostJobs(1000 + JOB_STALE_MS + 1);
    expect(await getJob(j.id)).toMatchObject({ status: 'lost' });
    await createJob(input, 1000 + JOB_STALE_MS + 2);   // no longer blocked
  });

  it('forgets finished jobs after a week', async () => {
    const old = await createJob(input, 1000);
    await finishJob(old.id, 'success', { steps: [], percent: 100, message: 'ok' }, 2000);
    await createJob({ ...input, serverId: 's9' }, 2000 + KEEP_FINISHED_MS + 10);   // creating a job prunes
    await new Promise(r => setTimeout(r, 10));
    expect(await getJob(old.id)).toBeNull();
  });

  it('the public view leaves out parameters and node', async () => {
    const j = await createJob(input, 1000);
    expect(Object.keys(viewOf(j)).sort()).toEqual(['actionId', 'cancelRequested', 'finishedAt', 'id', 'message', 'percent', 'startedAt', 'status', 'steps', 'updatedAt']);
  });
});

describe('outcomeOf', () => {
  const r = (over: Partial<Parameters<typeof outcomeOf>[0]> = {}) => ({ exitCode: 0, timedOut: false, stdout: '', stderr: '', ...over });
  it('success takes the DONE text', () => expect(outcomeOf(r({ stdout: '[step] x\nDONE installed 1.2\n' }))).toEqual({ status: 'success', message: 'installed 1.2' }));
  it('success without DONE', () => expect(outcomeOf(r())).toEqual({ status: 'success', message: 'Done' }));
  it('an ERROR line fails even with exit 0', () => expect(outcomeOf(r({ stdout: 'ERROR: disk full\n' }))).toEqual({ status: 'error', message: 'disk full' }));
  it('a non-zero exit fails with the error text', () => expect(outcomeOf(r({ exitCode: 3, stderr: 'boom\n' }))).toEqual({ status: 'error', message: 'boom' }));
  it('a non-zero exit without text', () => expect(outcomeOf(r({ exitCode: 4 }))).toEqual({ status: 'error', message: 'Failed (exit 4)' }));
  it('timeouts and aborts', () => {
    expect(outcomeOf(r({ timedOut: true, exitCode: 124 })).status).toBe('error');
    expect(outcomeOf(r({ aborted: true, exitCode: -1 }))).toEqual({ status: 'cancelled', message: 'Cancelled' });
  });
});

describe('running a job', () => {
  const loaded = { type: 'demo', packageId: 'pkg', spec: {}, network: [] } as never;
  const action = { id: 'go', label: 'Go' } as never;
  const start = () => startJob({ serverId: 's1', loaded, action, prepared: { scriptId: 'run', args: {} }, userId: 'u1', params: {} });
  const until = async (fn: () => boolean | Promise<boolean>, ms = 3000) => { const t = Date.now(); while (!(await fn())) { if (Date.now() - t > ms) throw new Error('timed out waiting'); await new Promise(r => setTimeout(r, 10)); } };

  it('follows the script live and records the result', async () => {
    let release!: () => void;
    const gate = new Promise<void>(res => { release = res; });
    scripts.run = async (_a, ext) => {
      ext.onData!('[step] Downloading\nPROGRESS 2/4\n', false);
      await gate;
      ext.onData!('[step] Installing\nDONE all set\n', false);
      return { stdout: '[step] Downloading\nPROGRESS 2/4\n[step] Installing\nDONE all set\n', stderr: '', exitCode: 0, timedOut: false };
    };
    const { job } = await start();
    expect(job.status).toBe('running');
    await until(async () => (await getJob(job.id))?.percent === 50);
    expect(await getJob(job.id)).toMatchObject({ status: 'running', steps: ['Downloading'], percent: 50 });
    release();
    await until(async () => (await getJob(job.id))?.status === 'success');
    expect(await getJob(job.id)).toMatchObject({ status: 'success', message: 'all set', percent: 100, steps: ['Downloading', 'Installing'] });
    expect(runningJobCount()).toBe(0);
    expect(audits.list.at(-1)).toMatchObject({ action: 'widget.action', status: 'success', serverId: 's1' });
    expect(JSON.parse(audits.list.at(-1)!.details as string)).toMatchObject({ job: job.id, finished: 'success', message: 'all set' });
  });

  it('a script that fails ends as an error with its message', async () => {
    scripts.run = async () => ({ stdout: '[step] Trying\nERROR: no space left\n', stderr: '', exitCode: 1, timedOut: false });
    const { job } = await start();
    await until(async () => (await getJob(job.id))?.status === 'error');
    expect(await getJob(job.id)).toMatchObject({ message: 'no space left', steps: ['Trying'] });
    expect(audits.list.at(-1)).toMatchObject({ status: 'failure' });
  });

  it('an exception while running becomes an error', async () => {
    scripts.run = async () => { throw new Error('connection lost'); };
    const { job } = await start();
    await until(async () => (await getJob(job.id))?.status === 'error');
    expect((await getJob(job.id))?.message).toBe('connection lost');
  });

  it('refuses a second job for the same widget on the server while one runs', async () => {
    scripts.run = (_a, ext) => new Promise(resolve => { ext.signal!.addEventListener('abort', () => resolve({ stdout: '', stderr: '', exitCode: -1, timedOut: false, aborted: true })); });
    const { job } = await start();
    await expect(start()).rejects.toMatchObject({ code: 'JOB_RUNNING', status: 409 });
    await cancelJob(job.id);
    await until(async () => (await getJob(job.id))?.status === 'cancelled');
    scripts.cancelled = [];
  });

  it('cancels on the node that runs it: aborts the run and stops the script on the host', async () => {
    scripts.run = (_a, ext) => new Promise(resolve => {
      ext.signal!.addEventListener('abort', () => resolve({ stdout: '[step] Working\n', stderr: '', exitCode: -1, timedOut: false, aborted: true }));
    });
    const { job } = await start();
    expect(await cancelJob(job.id)).toBe(true);
    await until(async () => (await getJob(job.id))?.status === 'cancelled');
    expect(await getJob(job.id)).toMatchObject({ message: 'Cancelled', steps: ['Working'] });
    expect(scripts.cancelled).toEqual([job.id]);
  });

  it('a cancel asked for on another node (only the flag in the database) is noticed at the next heartbeat', async () => {
    scripts.run = (_a, ext) => new Promise(resolve => {
      ext.signal!.addEventListener('abort', () => resolve({ stdout: '', stderr: '', exitCode: -1, timedOut: false, aborted: true }));
    });
    const { job } = await start();
    await requestCancel(job.id);                // what another node's cancel route does: no access to this process
    await until(async () => (await getJob(job.id))?.status === 'cancelled');
    expect(scripts.cancelled).toEqual([job.id]);
  });

  it('cancelling a job that is not running answers false', async () => {
    expect(await cancelJob('nope')).toBe(false);
  });
});
