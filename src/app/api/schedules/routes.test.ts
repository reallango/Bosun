import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const requireAuth = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/middleware', () => ({ requireAuth, clientIp: () => '127.0.0.1' }));

vi.mock('@/lib/schedules/service', () => {
  class ScheduleError extends Error {
    status: number;
    code: string;
    constructor(message: string, status = 400, code = 'VALIDATION') { super(message); this.status = status; this.code = code; }
  }
  return {
    ScheduleError,
    listSchedules: vi.fn(),
    createSchedule: vi.fn(),
    getSchedule: vi.fn(),
    updateSchedule: vi.fn(),
    deleteSchedule: vi.fn(),
    runScheduleNow: vi.fn(),
    listRuns: vi.fn(),
    listScheduleKinds: vi.fn(),
  };
});

import * as service from '@/lib/schedules/service';
import { GET as listGet, POST as createPost } from './route';
import { PATCH as idPatch, DELETE as idDelete } from './[id]/route';
import { POST as runPost } from './[id]/run/route';
import { GET as runsGet } from './[id]/runs/route';
import { GET as kindsGet } from './kinds/route';

const auth = { userId: 'u1', username: 'Uma', role: 'admin', authType: 'session' };
const params = (id = 's1') => ({ params: Promise.resolve({ id }) });
const req = (url = 'http://localhost/api/schedules', init?: ConstructorParameters<typeof NextRequest>[1]) => new NextRequest(url, init);
const json = (body: unknown, method = 'POST') => req('http://localhost/api/schedules', { method, headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });

beforeEach(() => {
  vi.mocked(requireAuth).mockReset().mockResolvedValue(auth as never);
  for (const fn of [service.listSchedules, service.createSchedule, service.getSchedule, service.updateSchedule, service.deleteSchedule, service.runScheduleNow, service.listRuns, service.listScheduleKinds]) {
    vi.mocked(fn).mockReset();
  }
});

describe('the schedules API refuses what it should', () => {
  it('refuses an unauthenticated request', async () => {
    vi.mocked(requireAuth).mockResolvedValue(new NextResponse('{}', { status: 401 }) as never);
    expect((await listGet(req())).status).toBe(401);
    expect(service.listSchedules).not.toHaveBeenCalled();
  });

  it('refuses a body that is not JSON or not an object', async () => {
    expect((await createPost(json('{nope'))).status).toBe(400);
    expect((await createPost(json([1, 2]))).status).toBe(400);
    expect((await idPatch(json('{nope', 'PATCH'), params())).status).toBe(400);
    expect(service.createSchedule).not.toHaveBeenCalled();
    expect(service.updateSchedule).not.toHaveBeenCalled();
  });

  it('passes the service refusal through with its status and code', async () => {
    vi.mocked(service.createSchedule).mockRejectedValue(new service.ScheduleError('You do not hold "Manage schedules" on that server', 403, 'FORBIDDEN'));
    const res = await createPost(json({ name: 'x' }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatchObject({ message: 'You do not hold "Manage schedules" on that server', code: 'FORBIDDEN' });
  });

  it('refuses to delete or change a schedule that is not there', async () => {
    vi.mocked(service.deleteSchedule).mockRejectedValue(new service.ScheduleError('Schedule not found', 404, 'NOT_FOUND'));
    expect((await idDelete(req('http://localhost/api/schedules/s1', { method: 'DELETE' }), params())).status).toBe(404);
    vi.mocked(service.updateSchedule).mockRejectedValue(new service.ScheduleError('Schedule not found', 404, 'NOT_FOUND'));
    expect((await idPatch(json({ enabled: false }, 'PATCH'), params())).status).toBe(404);
  });

  it('refuses run now while a run is in progress', async () => {
    vi.mocked(service.runScheduleNow).mockRejectedValue(new service.ScheduleError('A run of this schedule is already in progress', 409, 'RUNNING'));
    const res = await runPost(req('http://localhost/api/schedules/s1/run', { method: 'POST' }), params());
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('RUNNING');
  });

  it('needs a server for the discovery list', async () => {
    expect((await kindsGet(req('http://localhost/api/schedules/kinds'))).status).toBe(400);
    vi.mocked(service.listScheduleKinds).mockResolvedValue([]);
    const res = await kindsGet(req('http://localhost/api/schedules/kinds?server_id=srv1'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { kinds: [] } });
  });

  it('returns the created schedule and a page of history', async () => {
    vi.mocked(service.createSchedule).mockResolvedValue({ id: 's1' } as never);
    const created = await createPost(json({ name: 'x' }));
    expect(created.status).toBe(201);
    vi.mocked(service.listRuns).mockResolvedValue({ runs: [], nextOffset: null });
    const runs = await runsGet(req('http://localhost/api/schedules/s1/runs?limit=10&offset=20'), params());
    expect(runs.status).toBe(200);
    expect(service.listRuns).toHaveBeenCalledWith(auth, 's1', { limit: 10, offset: 20 });
  });
});
