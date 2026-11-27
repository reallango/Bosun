import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => ({ query: vi.fn(), execute: vi.fn() }));
vi.mock('@/lib/db/rqlite-client', () => ({
  rqlite: db,
  rowsToObjects: (r: { rows?: unknown[] } | undefined) => r?.rows ?? [],
}));

const hasPermission = vi.hoisted(() => vi.fn());
const permittedResources = vi.hoisted(() => vi.fn());
vi.mock('@/lib/permissions/authorize', () => ({ hasPermission, permittedResources }));

const serverVisible = vi.hoisted(() => vi.fn());
const visibleServerIds = vi.hoisted(() => vi.fn());
vi.mock('@/lib/permissions/effective', () => ({ serverVisible, visibleServerIds }));

const loadWidgetSpec = vi.hoisted(() => vi.fn());
vi.mock('@/lib/widgets/runtime/execute', () => ({ loadWidgetSpec }));

vi.mock('@/lib/widgets/runtime/resource-check', () => ({ resolveTarget: vi.fn(async () => null) }));
vi.mock('@/lib/audit/logger', () => ({ logAudit: vi.fn(async () => undefined) }));

const requesterOf = vi.hoisted(() => vi.fn());
vi.mock('@/lib/access/requests', () => ({ requesterOf }));

const executeScheduleRun = vi.hoisted(() => vi.fn());
vi.mock('./engine', () => ({ executeScheduleRun, nextRunAt: () => '2026-01-01T11:00:00.000Z' }));

import { createSchedule, listScheduleKinds, listSchedules, runScheduleNow, ScheduleError, updateSchedule } from './service';

const viewer = { userId: 'u1', username: 'Uma', role: 'admin', authType: 'session' as const };

const loaded = () => ({
  type: 'pkg', packageId: 'pkg', network: [],
  spec: {
    version: 2,
    data: { source: 'snapshot', section: 'services', permission: 'pkg.view' },
    view: { type: 'text', text: 'x' },
    actions: [{ id: 'restart', label: 'Restart', as: 'service', command: 'echo {{name}}', permission: 'pkg.control', params: { name: { type: 'string', pattern: '^[a-z]+$' } } }],
    scripts: { check: { as: 'service', linux: 'check.sh', params: {} } },
    datasets: { findings: { script: 'check', permission: 'pkg.view' } },
    schedules: [
      { id: 'check', label: 'Check', run: { dataset: 'findings' }, notify: { title: 'x', message: 'y' } },
      { id: 'restart_web', label: 'Restart', run: { action: 'restart' } },
    ],
  },
});

const scheduleRow = (over: Record<string, unknown> = {}) => ({
  id: 's1', name: 'Nightly', widget_type: 'pkg', schedule_kind: 'check', server_id: 'srv1', resource_kind: '', resource_name: '',
  cron: '0 3 * * *', timezone: 'UTC', enabled: 1, options: '{}', created_by_type: 'user', created_by_id: 'u1', created_by_name: 'Uma',
  created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', last_run_at: null,
  next_run_at: '2026-01-01T03:00:00.000Z', paused_reason: null, ...over,
});

beforeEach(() => {
  for (const fn of [db.query, db.execute, hasPermission, permittedResources, serverVisible, visibleServerIds, loadWidgetSpec, requesterOf, executeScheduleRun]) fn.mockReset();
  db.query.mockImplementation(async (sql: string) => {
    if (sql.startsWith('SELECT 1 FROM servers')) return { values: [[1]] };
    if (sql.startsWith('SELECT * FROM schedules WHERE id = ?')) return { rows: [scheduleRow()] };
    if (sql.startsWith('SELECT * FROM schedules ORDER BY')) return { rows: [scheduleRow()] };
    if (sql.startsWith('SELECT id, name FROM servers')) return { rows: [{ id: 'srv1', name: 'alpha' }] };
    return { rows: [], values: [] };
  });
  db.execute.mockResolvedValue({ rows_affected: 1 });
  hasPermission.mockResolvedValue(true);
  permittedResources.mockResolvedValue([]);
  serverVisible.mockResolvedValue(true);
  visibleServerIds.mockResolvedValue('*');
  loadWidgetSpec.mockResolvedValue(loaded());
  requesterOf.mockReturnValue({ type: 'user', id: 'u1', name: 'Uma' });
});

const input = (over: Record<string, unknown> = {}) => ({
  name: 'Nightly', widget_type: 'pkg', schedule_kind: 'check', server_id: 'srv1',
  cron: '0 3 * * *', timezone: 'UTC', ...over,
});

describe('creating a schedule', () => {
  it('refuses without "Manage schedules" on the server', async () => {
    hasPermission.mockResolvedValue(false);
    await expect(createSchedule(viewer, input())).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('refuses the widget permission the run needs', async () => {
    hasPermission.mockImplementation(async (_v: unknown, p: string) => p === 'schedules.manage');
    await expect(createSchedule(viewer, input())).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
    await expect(createSchedule(viewer, input())).rejects.toThrow(/pkg\.view/);
  });

  it('refuses an action schedule that does not fix every required parameter', async () => {
    const err = await createSchedule(viewer, input({ schedule_kind: 'restart_web' })).catch(e => e);
    expect(err).toBeInstanceOf(ScheduleError);
    expect(err).toMatchObject({ status: 400, code: 'INVALID_PARAMS' });
    expect(err.message).toContain('Missing parameter: name');
  });

  it('refuses a broken timetable or an unknown time zone', async () => {
    await expect(createSchedule(viewer, input({ cron: '0 3 * *' }))).rejects.toThrow(/Cron expression/);
    await expect(createSchedule(viewer, input({ timezone: 'Mars/Olympus' }))).rejects.toThrow(/IANA/);
  });

  it('stores the schedule with the creator and the next run, and audits it', async () => {
    const dto = await createSchedule(viewer, input());
    expect(dto).toMatchObject({ name: 'Nightly', server_name: 'alpha', enabled: true });
    expect(db.execute.mock.calls.some(c => String(c[0]).includes('INSERT INTO schedules'))).toBe(true);
    const insert = db.execute.mock.calls.find(c => String(c[0]).includes('INSERT INTO schedules'))!;
    expect(insert[1]).toContain('Uma');
    expect(insert[1]).toContain('2026-01-01T11:00:00.000Z');
  });
});

describe('pausing a schedule', () => {
  it('needs only "Manage schedules", not the widget permission', async () => {
    hasPermission.mockImplementation(async (_v: unknown, p: string) => p === 'schedules.manage');
    const dto = await updateSchedule(viewer, 's1', { enabled: false });
    expect(dto).toBeTruthy();
    expect(db.execute.mock.calls.some(c => String(c[0]).includes('enabled = 0') && (c[1] as unknown[]).includes('Paused by Uma'))).toBe(true);
  });

  it('refuses a resume the creator could not run', async () => {
    db.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith('SELECT * FROM schedules WHERE id = ?')) return { rows: [scheduleRow({ enabled: 0, paused_reason: 'Paused by Uma' })] };
      if (sql.startsWith('SELECT 1 FROM servers')) return { values: [[1]] };
      return { rows: [], values: [] };
    });
    hasPermission.mockImplementation(async (_v: unknown, p: string) => p === 'schedules.manage');
    await expect(updateSchedule(viewer, 's1', { enabled: true })).rejects.toMatchObject({ status: 403 });
  });
});

describe('what a viewer may see', () => {
  it('lists only schedules on visible servers where the viewer may manage', async () => {
    db.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith('SELECT * FROM schedules ORDER BY')) {
        return { rows: [scheduleRow({ id: 'a', server_id: 'srv1' }), scheduleRow({ id: 'b', server_id: 'srv2' })] };
      }
      if (sql.startsWith('SELECT id, name FROM servers')) return { rows: [{ id: 'srv1', name: 'alpha' }, { id: 'srv2', name: 'beta' }] };
      return { rows: [], values: [] };
    });
    hasPermission.mockImplementation(async (_v: unknown, p: string, server: string) => p === 'schedules.manage' && server === 'srv1');
    const list = await listSchedules(viewer);
    expect(list.map(s => s.id)).toEqual(['a']);
  });

  it('offers kinds only where the viewer may manage the server and holds the run permission', async () => {
    db.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith('SELECT 1 FROM servers')) return { values: [[1]] };
      if (sql.includes('FROM custom_widgets')) return { rows: [{ type: 'pkg', display_name: 'Package' }] };
      return { rows: [], values: [] };
    });
    hasPermission.mockImplementation(async (_v: unknown, p: string) => p === 'schedules.manage');
    expect(await listScheduleKinds(viewer, 'srv1')).toEqual([]);
    hasPermission.mockResolvedValue(true);
    const kinds = await listScheduleKinds(viewer, 'srv1');
    expect(kinds.map(k => k.id).sort()).toEqual(['check', 'restart_web']);
    expect(kinds[0]).toMatchObject({ widget_type: 'pkg', package_id: 'pkg', target: 'server' });
  });
});

describe('run now', () => {
  it('refuses a schedule the viewer cannot see', async () => {
    serverVisible.mockResolvedValue(false);
    await expect(runScheduleNow(viewer, 's1')).rejects.toMatchObject({ status: 404 });
  });

  it('refuses when a run is already in progress', async () => {
    executeScheduleRun.mockResolvedValue({ started: false, message: 'A run of this schedule is already in progress' });
    await expect(runScheduleNow(viewer, 's1')).rejects.toMatchObject({ status: 409, code: 'RUNNING' });
  });

  it('starts a run for the creator', async () => {
    executeScheduleRun.mockResolvedValue({ started: true, status: 'success', matchedCount: 2 });
    await expect(runScheduleNow(viewer, 's1')).resolves.toMatchObject({ started: true, status: 'success' });
    expect(executeScheduleRun).toHaveBeenCalledWith('s1', expect.objectContaining({ trigger: 'manual', actor: viewer }));
  });
});
