/**
 * One-time command and terminal access requests, exercised through the real `requests.ts` logic with an in-memory
 * database and the permission/SSH/terminal boundaries faked: those are external systems (rqlite over HTTP, SSH), and
 * the behaviour under test is the request lifecycle (create -> approve/deny/expire -> run exactly once -> result).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  const state = {
    requests: new Map<string, Row>(),
    servers: [{ id: 'srv-1', name: 'Alpha' }],
    runCalls: [] as Array<Record<string, unknown>>,
    openCalls: [] as Array<Record<string, unknown>>,
    requester: { userId: 'u-requester', username: 'requester', role: 'operator', authType: 'user' } as Record<string, unknown>,
    runResult: { stdout: 'ok\n', stderr: '', exitCode: 0, timedOut: false, account: 'deploy', as: 'user' } as Record<string, unknown>,
  };

  const cols = (rows: Row[]) => ({
    columns: rows.length ? Object.keys(rows[0]) : [],
    values: rows.map(r => Object.values(r)),
  });
  const rowsToObjects = (result: { columns?: string[]; values?: unknown[][] }) =>
    (result.values ?? []).map(row => Object.fromEntries((result.columns ?? []).map((c, i) => [c, row[i]])));

  function insert(sql: string, params: unknown[]): Row {
    const m = sql.match(/INSERT INTO (\w+) \(([^)]+)\) VALUES \(([^)]+)\)/);
    if (!m) throw new Error(`fake rqlite cannot parse: ${sql}`);
    const columns = m[2].split(',').map(c => c.trim());
    const tokens = m[3].split(',').map(t => t.trim());
    let p = 0;
    const row: Row = { decided_by: null, decided_by_name: null, decided_at: null, decision_note: null, result: null };
    tokens.forEach((token, i) => {
      row[columns[i]] = token === '?' ? params[p++] : token.replace(/^'|'$/g, '');
    });
    return row;
  }

  const rqlite = {
    async query(sql: string, params: unknown[] = []) {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s.startsWith('SELECT name FROM servers WHERE id')) {
        const r = state.servers.find(x => x.id === params[0]);
        return cols(r ? [{ name: r.name }] : []);
      }
      if (s === 'SELECT id, name FROM servers') return cols(state.servers.map(r => ({ id: r.id, name: r.name })));
      if (s.startsWith("SELECT id FROM access_requests WHERE status = 'pending' AND expires_at <")) {
        return cols(Array.from(state.requests.values())
          .filter(r => r.status === 'pending' && String(r.expires_at) < String(params[0]))
          .map(r => ({ id: r.id })));
      }
      if (s.startsWith('SELECT 1 FROM servers WHERE id')) {
        return cols(state.servers.some(x => x.id === params[0]) ? [{ 1: 1 }] : []);
      }
      if (s.startsWith('SELECT COUNT(*) FROM access_requests')) {
        const n = Array.from(state.requests.values())
          .filter(r => r.requester_type === params[0] && r.requester_id === params[1] && r.status === 'pending').length;
        return cols([{ 'COUNT(*)': n }]);
      }
      if (s === 'SELECT * FROM access_requests WHERE id = ?') {
        const r = state.requests.get(String(params[0]));
        return cols(r ? [r] : []);
      }
      throw new Error(`fake rqlite cannot query: ${s}`);
    },
    async execute(sql: string, params: unknown[] = []) {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s.startsWith('INSERT INTO access_requests')) {
        const row = insert(s, params);
        state.requests.set(String(row.id), row);
        return { rows_affected: 1 };
      }
      if (s.startsWith("UPDATE access_requests SET status = 'expired' WHERE id = ? AND status = 'pending'")) {
        const r = state.requests.get(String(params[0]));
        if (!r || r.status !== 'pending') return { rows_affected: 0 };
        r.status = 'expired';
        return { rows_affected: 1 };
      }
      if (s.startsWith('UPDATE access_requests SET status = ?, decided_by = ?, decided_by_name = ?, decided_at = ?, decision_note = ? WHERE id = ? AND status = \'pending\'')) {
        const r = state.requests.get(String(params[5]));
        if (!r || r.status !== 'pending') return { rows_affected: 0 };
        r.status = params[0]; r.decided_by = params[1]; r.decided_by_name = params[2]; r.decided_at = params[3]; r.decision_note = params[4];
        return { rows_affected: 1 };
      }
      if (s.startsWith('UPDATE access_requests SET status = ?, result = ? WHERE id = ?')) {
        const r = state.requests.get(String(params[2]));
        if (!r) return { rows_affected: 0 };
        r.status = params[0]; r.result = params[1];
        return { rows_affected: 1 };
      }
      throw new Error(`fake rqlite cannot execute: ${s}`);
    },
    async executeBatch(statements: Array<{ sql: string; params?: unknown[] }>) {
      for (const st of statements) await rqlite.execute(st.sql, st.params ?? []);
    },
  };

  return {
    state, rqlite, rowsToObjects,
    async runServerCommand(opts: Record<string, unknown>) {
      state.runCalls.push(opts);
      return {
        ...state.runResult,
        as: opts.as,
        account: opts.as === 'service' ? 'root' : 'deploy',
      };
    },
    async openTerminal(_owner: string, _auth: unknown, opts: Record<string, unknown>) {
      state.openCalls.push(opts);
      return { session_id: 'sess-1', server_id: opts.serverId, as: opts.as, container: (opts.container as string | null) ?? null, idle_timeout_sec: 900 };
    },
    // Must match the PermissionDef shape used by permissionDef()/audienceFor().
    defs: [
      { id: 'shell.user', label: 'Host shell (non-admin)', description: 'Run commands as the non-admin account.', group: 'Shell', source: 'core', defaultLevel: 'operator', risk: 'high', scope: 'server' },
      { id: 'exec.service', label: 'Service account exec', description: 'Run commands as the service account.', group: 'Shell', source: 'core', defaultLevel: 'admin', risk: 'high', scope: 'server' },
      { id: 'docker.shell', label: 'Container shell', description: 'Open a shell in a container.', group: 'Docker', source: 'core', defaultLevel: 'operator', risk: 'high', scope: 'server' },
    ],
    reset() {
      state.requests.clear();
      state.runCalls.length = 0;
      state.openCalls.length = 0;
      state.requester = { userId: 'u-requester', username: 'requester', role: 'operator', authType: 'user' };
      state.runResult = { stdout: 'ok\n', stderr: '', exitCode: 0, timedOut: false, account: 'deploy', as: 'user' };
    },
  };
});

vi.mock('@/lib/db/rqlite-client', () => ({ rqlite: h.rqlite, rowsToObjects: h.rowsToObjects }));
vi.mock('@/lib/permissions/store', () => ({ registeredPermissionDefs: async () => h.defs, invalidatePermissionCache: () => {} }));
vi.mock('@/lib/permissions/authorize', () => ({
  hasPermission: async (auth: { role?: string }) => auth.role === 'admin',
}));
vi.mock('@/lib/permissions/effective', () => ({ serverVisible: async () => true }));
vi.mock('@/lib/notifications/store', () => ({ notify: async () => {}, resolveByKeyPrefix: async () => {} }));
vi.mock('@/lib/audit/logger', () => ({ logAudit: async () => {} }));
vi.mock('@/lib/access/requester', () => ({ requesterPayload: async () => h.state.requester }));
vi.mock('@/lib/exec/run-command', () => ({ runServerCommand: h.runServerCommand }));
vi.mock('@/lib/terminal/mcp-sessions', () => ({
  getMcpTerminalManager: () => ({ open: h.openTerminal }),
  principalKey: (auth: { userId?: string }) => `user:${String(auth.userId)}`,
}));

import { createRequest, decideRequest, expireStale, getRequest, RequestError } from './requests';

const requester = () => ({ userId: 'u-requester', username: 'requester', role: 'operator', authType: 'user' } as never);
const approver = () => ({ userId: 'u-admin', username: 'admin', role: 'admin', authType: 'user' } as never);

describe('one-time command access requests', () => {
  beforeEach(() => h.reset());

  it('creates a pending request showing the exact command and account', async () => {
    const created = await createRequest(requester(), { kind: 'command', serverId: 'srv-1', command: 'systemctl status nginx', as: 'user', reason: 'check' });
    expect(created.kind).toBe('command');
    expect(created.status).toBe('pending');
    expect(created.permission).toBe('shell.user');
    expect(created.command).toEqual({ command: 'systemctl status nginx', as: 'user', container: null });
    expect(created.summary).toContain('systemctl status nginx');
    expect(created.summary).toContain('non-admin account');
    expect(h.state.runCalls).toHaveLength(0);
  });

  it('runs the command once on approval and stores the result', async () => {
    const created = await createRequest(requester(), { kind: 'command', serverId: 'srv-1', command: 'uptime', as: 'service', reason: 'check load' });
    expect(created.summary).toContain('service account');

    const approved = await decideRequest(approver(), created.id, 'approve', 'ok', '127.0.0.1');
    expect(approved.status).toBe('approved');
    expect(h.state.runCalls).toHaveLength(1);
    expect(h.state.runCalls[0]).toMatchObject({ serverId: 'srv-1', command: 'uptime', as: 'service', userId: 'u-requester', approvedBy: 'admin', requestId: created.id });
    expect(approved.result).toMatchObject({ exitCode: 0, stdout: 'ok\n', as: 'service', account: 'root' });

    await expect(decideRequest(approver(), created.id, 'approve', null)).rejects.toMatchObject({ code: 'NOT_PENDING' });
    expect(h.state.runCalls).toHaveLength(1);
  });

  it('denies without running anything', async () => {
    const created = await createRequest(requester(), { kind: 'command', serverId: 'srv-1', command: 'rm -rf /tmp/x', as: 'user', reason: 'cleanup' });
    const denied = await decideRequest(approver(), created.id, 'deny', 'no', undefined);
    expect(denied.status).toBe('denied');
    expect(h.state.runCalls).toHaveLength(0);
  });

  it('expires a stale request and refuses to decide it', async () => {
    const created = await createRequest(requester(), { kind: 'command', serverId: 'srv-1', command: 'id', as: 'user', reason: 'look' });
    const row = h.state.requests.get(created.id)!;
    row.expires_at = new Date(Date.now() - 1000).toISOString();
    await expireStale();
    expect(h.state.requests.get(created.id)!.status).toBe('expired');
    await expect(decideRequest(approver(), created.id, 'approve', null)).rejects.toBeInstanceOf(RequestError);
    expect(h.state.runCalls).toHaveLength(0);
  });

  it('does not create a request when the caller already holds the permission', async () => {
    const admin = { userId: 'u-admin', username: 'admin', role: 'admin', authType: 'user' } as never;
    await expect(createRequest(admin, { kind: 'command', serverId: 'srv-1', command: 'id', as: 'user', reason: 'look' }))
      .rejects.toMatchObject({ code: 'ALREADY_GRANTED' });
  });
});

describe('one-time terminal access requests', () => {
  beforeEach(() => h.reset());

  it('opens one session on approval for the requester', async () => {
    const created = await createRequest(requester(), { kind: 'terminal', serverId: 'srv-1', as: 'service', container: null, reason: 'debug' });
    expect(created.kind).toBe('terminal');
    expect(created.permission).toBe('exec.service');
    expect(created.command).toEqual({ command: '', as: 'service', container: null });

    const approved = await decideRequest(approver(), created.id, 'approve', null);
    expect(approved.status).toBe('approved');
    expect(h.state.openCalls).toHaveLength(1);
    expect(h.state.openCalls[0]).toMatchObject({ serverId: 'srv-1', as: 'service', container: null });
    expect(approved.result).toMatchObject({ session_id: 'sess-1' });
  });

  it('asks for docker.shell when a container is named', async () => {
    const created = await createRequest(requester(), { kind: 'terminal', serverId: 'srv-1', as: 'user', container: 'web-1', reason: 'logs' });
    expect(created.permission).toBe('docker.shell');
    expect(created.resource).toEqual({ kind: 'container', name: 'web-1' });
  });
});

describe('getRequest after a decision', () => {
  beforeEach(() => h.reset());

  it('exposes the stored result so access_request_wait can read it', async () => {
    const created = await createRequest(requester(), { kind: 'command', serverId: 'srv-1', command: 'echo hi', as: 'user', reason: 'test' });
    h.state.runResult = { stdout: 'hi\n', stderr: '', exitCode: 0, timedOut: false, account: 'deploy', as: 'user' };
    await decideRequest(approver(), created.id, 'approve', null);
    const read = await getRequest(approver(), created.id);
    expect(read?.status).toBe('approved');
    expect(read?.result).toMatchObject({ stdout: 'hi\n', exitCode: 0 });
  });
});
