import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => ({ query: vi.fn(), execute: vi.fn(), getStatus: vi.fn() }));
vi.mock('@/lib/db/rqlite-client', () => ({
  rqlite: db,
  rowsToObjects: (r: { rows?: unknown[] } | undefined) => r?.rows ?? [],
}));

const requesterPayload = vi.hoisted(() => vi.fn());
vi.mock('@/lib/access/requester', () => ({ requesterPayload }));

const hasPermission = vi.hoisted(() => vi.fn());
vi.mock('@/lib/permissions/authorize', () => ({ hasPermission }));

const loadWidgetSpec = vi.hoisted(() => vi.fn());
const loadDataset = vi.hoisted(() => vi.fn());
vi.mock('@/lib/widgets/runtime/execute', () => ({ loadWidgetSpec, loadDataset }));

const notify = vi.hoisted(() => vi.fn());
vi.mock('@/lib/notifications/store', () => ({ notify }));

const logAudit = vi.hoisted(() => vi.fn());
vi.mock('@/lib/audit/logger', () => ({ logAudit }));

const resolveTarget = vi.hoisted(() => vi.fn());
vi.mock('@/lib/widgets/runtime/resource-check', () => ({
  resolveTarget,
  viewFilter: async () => 'all',
  filterRows: (data: unknown) => data,
}));

const runWidgetAction = vi.hoisted(() => vi.fn());
vi.mock('@/lib/widgets/runtime/run-action', () => ({ runWidgetAction }));

vi.mock('@/lib/widgets/jobs/store', () => ({ getJob: vi.fn() }));

import { claimSchedule, executeScheduleRun, startRunRow, tickSchedules } from './engine';

const row = (over: Record<string, unknown> = {}) => ({
  id: 's1', name: 'Nightly', widget_type: 'pkg', schedule_kind: 'check', server_id: 'srv1',
  resource_kind: '', resource_name: '', cron: '0 * * * *', timezone: 'UTC', enabled: 1, options: '{}',
  created_by_type: 'user', created_by_id: 'u1', created_by_name: 'Uma', created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z', last_run_at: null, next_run_at: '2026-01-01T10:00:00.000Z', paused_reason: null,
  ...over,
});

const loaded = () => ({
  type: 'pkg', packageId: 'pkg', network: [],
  spec: {
    version: 2,
    data: { source: 'snapshot', section: 'services', permission: 'pkg.view' },
    view: { type: 'text', text: 'x' },
    actions: [],
    scripts: { check: { as: 'service', linux: 'check.sh', params: {} } },
    datasets: { findings: { script: 'check', permission: 'pkg.view' } },
    schedules: [{ id: 'check', label: 'Check', run: { dataset: 'findings' }, notify: { title: '{count} found', message: '{schedule} on {server}' } }],
  },
});

const user = { userId: 'u1', username: 'Uma', role: 'admin', authType: 'session' };

beforeEach(() => {
  for (const fn of [db.query, db.execute, db.getStatus, requesterPayload, hasPermission, loadWidgetSpec, loadDataset, notify, logAudit, resolveTarget, runWidgetAction]) fn.mockReset();
  db.query.mockImplementation(async (sql: string) => {
    if (sql.startsWith('SELECT * FROM schedules')) return { rows: [row()] };
    if (sql.startsWith('SELECT name FROM servers')) return { values: [['alpha']] };
    return { rows: [], values: [] };
  });
  db.execute.mockResolvedValue({ rows_affected: 1 });
  requesterPayload.mockResolvedValue(user);
  hasPermission.mockResolvedValue(true);
  loadWidgetSpec.mockResolvedValue(loaded());
  loadDataset.mockResolvedValue({ data: [{ available: true }, { available: true }, { available: false }] });
  notify.mockResolvedValue(true);
  resolveTarget.mockResolvedValue({ kind: 'stack', name: 'web' });
});

const executed = (sqlPart: string) => db.execute.mock.calls.some(c => String(c[0]).includes(sqlPart));

describe('the claim a due run needs', () => {
  it('wins only while the row still has the value it read', async () => {
    db.execute.mockResolvedValueOnce({ rows_affected: 1 }).mockResolvedValueOnce({ rows_affected: 0 });
    expect(await claimSchedule('s1', '2026-01-01T10:00:00.000Z', '2026-01-01T11:00:00.000Z', '2026-01-01T10:30:00.000Z')).toBe(true);
    expect(await claimSchedule('s1', '2026-01-01T10:00:00.000Z', '2026-01-01T11:00:00.000Z', '2026-01-01T10:30:00.000Z')).toBe(false);
    const [sql, params] = db.execute.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('next_run_at = ?');
    expect(sql).toContain('enabled = 1');
    expect(params).toEqual(['2026-01-01T11:00:00.000Z', '2026-01-01T10:30:00.000Z', 's1', '2026-01-01T10:00:00.000Z']);
  });

  it('starts one run row only when none is running', async () => {
    db.execute.mockResolvedValueOnce({ rows_affected: 1 }).mockResolvedValueOnce({ rows_affected: 0 });
    expect(await startRunRow('s1')).toEqual(expect.any(String));
    expect(await startRunRow('s1')).toBeNull();
    expect(String(db.execute.mock.calls[0][0])).toContain('NOT EXISTS');
  });
});

describe('a dataset run', () => {
  it('loads the data as the creator, counts the rows and raises one notice', async () => {
    const out = await executeScheduleRun('s1', { trigger: 'schedule' });
    expect(out).toMatchObject({ started: true, status: 'success', matchedCount: 3 });
    expect(loadDataset).toHaveBeenCalledWith('srv1', expect.objectContaining({ packageId: 'pkg' }), 'findings', {});
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatchObject({
      kind: 'alert', severity: 'info', audience: 'admin', serverId: 'srv1', link: '/settings/schedules',
      title: '3 found', message: 'Nightly on alpha', data: { scheduleId: 's1', count: 3 },
    });
    expect(notify.mock.calls[0][0].dedupeKey).toMatch(/^schedule-notice:s1:\d{4}-\d{2}-\d{2}$/);
    expect(executed("status = ?")).toBe(true);
    expect(logAudit.mock.calls.some(c => c[0].action === 'schedule.execute' && c[0].status === 'success')).toBe(true);
  });

  it('raises no notice when no row matches the condition', async () => {
    const withWhen = loaded();
    (withWhen.spec.schedules[0] as { notify?: unknown }).notify = { when: { field: 'available', equals: 'never' }, title: '{count}', message: '{server}' };
    loadWidgetSpec.mockResolvedValue(withWhen);
    const out = await executeScheduleRun('s1', { trigger: 'schedule' });
    expect(out).toMatchObject({ status: 'success', matchedCount: 0 });
    expect(notify).not.toHaveBeenCalled();
  });

  it('pauses when the creator no longer holds the widget permission', async () => {
    hasPermission.mockImplementation(async (_viewer: unknown, permission: string) => permission === 'schedules.manage');
    const out = await executeScheduleRun('s1', { trigger: 'schedule' });
    expect(out.status).toBe('skipped');
    expect(out.message).toContain('no longer holds');
    expect(executed('enabled = 0')).toBe(true);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatchObject({ severity: 'warning', title: 'Schedule paused: Nightly' });
    expect(db.execute.mock.calls.some(c => (c[1] as unknown[]).includes('skipped'))).toBe(true);
    expect(loadDataset).not.toHaveBeenCalled();
  });

  it('pauses when the user that created it is gone', async () => {
    requesterPayload.mockResolvedValue(null);
    const out = await executeScheduleRun('s1', { trigger: 'schedule' });
    expect(out.status).toBe('skipped');
    expect(out.message).toContain('no longer exists');
    expect(executed('enabled = 0')).toBe(true);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('pauses when the widget no longer offers the kind', async () => {
    loadWidgetSpec.mockResolvedValue(null);
    const out = await executeScheduleRun('s1', { trigger: 'schedule' });
    expect(out.status).toBe('skipped');
    expect(out.message).toContain('no longer offers');
    expect(executed('enabled = 0')).toBe(true);
  });

  it('does not start a second run while one is in progress', async () => {
    db.execute.mockResolvedValueOnce({ rows_affected: 0 });
    const out = await executeScheduleRun('s1', { trigger: 'schedule' });
    expect(out).toEqual({ started: false, message: 'A run of this schedule is already in progress' });
  });
});

describe('a dataset run for a target that takes its kind from a parameter', () => {
  it('passes the stored name and kind to the dataset', async () => {
    const byKind = loaded();
    byKind.spec.scripts.check.params = { name: { type: 'string', maxLength: 100 }, kind: { type: 'string', values: ['stack', 'container'] } } as never;
    byKind.spec.datasets.findings = { script: 'check', permission: 'pkg.view', target: { byKind: 'kind', param: 'name' } } as never;
    loadWidgetSpec.mockResolvedValue(byKind);
    db.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith('SELECT * FROM schedules')) return { rows: [row({ resource_kind: 'stack', resource_name: 'web' })], values: [] };
      if (sql.startsWith('SELECT name FROM servers')) return { values: [['alpha']], rows: [] };
      return { rows: [], values: [] };
    });
    const out = await executeScheduleRun('s1', { trigger: 'schedule' });
    expect(out).toMatchObject({ started: true });
    // Without the kind the script refuses the run ("missing parameter kind"), so every occurrence fails.
    expect(loadDataset).toHaveBeenCalledWith('srv1', expect.objectContaining({ packageId: 'pkg' }), 'findings', { name: 'web', kind: 'stack' });
  });
});

describe('the engine tick', () => {
  it('does nothing off the leader', async () => {
    db.getStatus.mockResolvedValue({ store: { raft: { state: 'Follower' } } });
    expect(await tickSchedules(new Date('2026-01-01T10:30:00Z'))).toBe(0);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('claims a due schedule on the leader', async () => {
    db.getStatus.mockResolvedValue({ store: { raft: { state: 'Leader' } } });
    db.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM schedules WHERE enabled')) return { rows: [row()] };
      return { rows: [], values: [] };
    });
    expect(await tickSchedules(new Date('2026-01-01T10:30:00Z'))).toBe(1);
    expect(claimScheduleCalled()).toBe(true);
  });

  it('records a skipped run when the cluster was down for more than one interval', async () => {
    db.getStatus.mockResolvedValue({ store: { raft: { state: 'Leader' } } });
    db.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM schedules WHERE enabled')) return { rows: [row()] };
      if (sql.startsWith('SELECT * FROM schedules')) return { rows: [row()] };
      return { rows: [], values: [] };
    });
    expect(await tickSchedules(new Date('2026-01-01T12:30:00Z'))).toBe(0);
    expect(db.execute.mock.calls.some(c => (c[1] as unknown[]).includes('skipped'))).toBe(true);
  });
});

function claimScheduleCalled(): boolean {
  return db.execute.mock.calls.some(c => String(c[0]).includes('next_run_at = ?') && (c[1] as unknown[]).includes('s1'));
}
