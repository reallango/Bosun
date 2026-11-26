import { describe, it, expect, vi, beforeEach } from 'vitest';

const notices: Array<Record<string, unknown>> = [];
let row: Record<string, unknown>;
let keyCreator: string | null = 'u-owner';

vi.mock('@/lib/db/rqlite-client', () => {
  const objects = (cols: string[], values: unknown[][]) => ({ columns: cols, values });
  return {
    rowsToObjects: (r: { columns?: string[]; values?: unknown[][] }) => (r.values || []).map(v => Object.fromEntries((r.columns || []).map((c, i) => [c, v[i]]))),
    rqlite: {
      query: async (sql: string) => {
        if (sql.startsWith("SELECT id FROM access_requests WHERE status = 'pending'")) return objects(['id'], []);
        if (sql.startsWith('SELECT * FROM access_requests')) return objects(Object.keys(row), [Object.values(row)]);
        if (sql.startsWith('SELECT created_by FROM api_keys')) return objects(['created_by'], keyCreator ? [[keyCreator]] : []);
        if (sql.startsWith('SELECT id, name FROM servers')) return objects(['id', 'name'], [['s1', 'Dock-Ubuntu']]);
        throw new Error(`unexpected query: ${sql}`);
      },
      execute: async (sql: string, params: unknown[]) => {
        if (sql.startsWith('UPDATE access_requests SET status = ?, decided_by')) { row = { ...row, status: params[0], decided_by_name: params[2], decided_at: params[3], decision_note: params[4] }; return { rows_affected: 1 }; }
        if (sql.startsWith('UPDATE access_requests SET status = ?, result')) { row = { ...row, status: params[0], result: params[1] }; return { rows_affected: 1 }; }
        throw new Error(`unexpected execute: ${sql}`);
      },
    },
  };
});
vi.mock('@/lib/notifications/store', () => ({ notify: async (n: Record<string, unknown>) => { notices.push(n); return true; }, resolveByKeyPrefix: async () => undefined }));
vi.mock('@/lib/audit/logger', () => ({ logAudit: async () => undefined }));
vi.mock('@/lib/permissions/effective', () => ({ serverVisible: async () => true }));
vi.mock('@/lib/permissions/authorize', () => ({ hasPermission: async () => true }));
vi.mock('@/lib/permissions/store', () => ({ registeredPermissionDefs: async () => [], invalidatePermissionCache: () => undefined }));
vi.mock('@/lib/auth/user-status', () => ({ getUserStatus: async () => null }));
vi.mock('@/lib/widgets/jobs/store', () => ({ redactParams: (p: unknown) => p }));

const admin = { userId: 'u-admin', username: 'lango', role: 'admin', authType: 'session' } as never;
const base = (over: Record<string, unknown>) => ({
  id: 'r1', requester_type: 'api_key', requester_id: 'k1', requester_name: 'Agent', kind: 'grant', permission: 'servers.refresh',
  server_id: 's1', resource_kind: '', resource_name: '', duration_hours: 2, action: null, reason: 'read logs', status: 'pending',
  created_at: '2026-11-26T09:00:00Z', expires_at: '2026-11-27T09:00:00Z', decided_by_name: null, decided_at: null, decision_note: null, result: null,
  ...over,
});

beforeEach(() => { notices.length = 0; keyCreator = 'u-owner'; });

describe('telling the requester about the decision', () => {
  it('an API key\'s decision goes to the bell of the person who made the key, and only theirs', async () => {
    row = base({});
    const { decideRequest } = await import('./requests');
    const r = await decideRequest(admin, 'r1', 'deny', 'not today', undefined);
    expect(r.status).toBe('denied');
    expect(r.decision_note).toBe('not today');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ kind: 'access_decision', severity: 'warning', recipientUserId: 'u-owner', serverId: 's1', dedupeKey: 'access-decision:r1' });
    expect(String(notices[0].title)).toBe('Your API key Agent\'s request was denied');
    expect(String(notices[0].message)).toMatch(/decided by lango\. Note: not today$/);
  });

  it('a person\'s own request goes to their own bell', async () => {
    row = base({ requester_type: 'user', requester_id: 'u-dev', requester_name: 'dev' });
    const { decideRequest } = await import('./requests');
    await decideRequest(admin, 'r1', 'deny', null, undefined);
    expect(notices[0]).toMatchObject({ recipientUserId: 'u-dev', title: 'Your request was denied' });
  });

  it('a key without a known creator gets no bell notice (it reads the request instead)', async () => {
    keyCreator = null;
    row = base({});
    const { decideRequest } = await import('./requests');
    await decideRequest(admin, 'r1', 'deny', null, undefined);
    expect(notices).toHaveLength(0);
  });
});

describe('waiting for a decision', () => {
  it('answers as soon as the request is decided, or still pending when the time is up', async () => {
    row = base({});
    const { waitForDecision } = await import('./requests');
    const requester = { userId: 'apikey:k1', username: 'Agent', role: 'viewer', authType: 'api_key', apiKeyId: 'k1' } as never;
    setTimeout(() => { row = { ...row, status: 'approved', decided_by_name: 'lango' }; }, 30);
    const t0 = Date.now();
    const r = await waitForDecision(requester, 'r1', 5, 10);
    expect(r?.status).toBe('approved');
    expect(Date.now() - t0).toBeLessThan(1000);

    row = base({});
    const t1 = Date.now();
    const still = await waitForDecision(requester, 'r1', 0.05, 10);
    expect(still?.status).toBe('pending');
    expect(Date.now() - t1).toBeLessThan(1000);
  });
});
