import { describe, it, expect, vi, beforeEach } from 'vitest';

const config = new Map<string, string>();
const notices: string[] = [];
const calls: string[] = [];
let stackSource = 'external';
let portainerHas = true;
let userAdmin = true;

vi.mock('@/lib/db/rqlite-client', () => ({
  rowsToObjects: (r: { rows: unknown[] }) => r.rows,
  rqlite: {
    query: async (_sql: string, [key]: [string]) => ({ rows: config.has(key) ? [{ value: config.get(key) }] : [] }),
    execute: async (sql: string, p: string[]) => {
      if (sql.startsWith('INSERT')) { if (config.has(p[0])) return { rows_affected: 0 }; config.set(p[0], p[1]); return { rows_affected: 1 }; }
      if (sql.startsWith('UPDATE')) { const [value, key, old] = p; if (config.get(key) !== old) return { rows_affected: 0 }; config.set(key, value); return { rows_affected: 1 }; }
      if (sql.startsWith('DELETE') && p.length === 2) { const [key, old] = p; if (config.get(key) !== old) return { rows_affected: 0 }; config.delete(key); return { rows_affected: 1 }; }
      if (sql.startsWith('DELETE')) { config.delete(p[0]); return { rows_affected: 1 }; }
      throw new Error(sql);
    },
  },
}));
vi.mock('@/lib/network/node-host', () => ({ nodeName: () => 'solo' }));
vi.mock('@/lib/auth/user-status', () => ({ getUserStatus: async () => ({ role: userAdmin ? 'admin' : 'viewer', disabled: false }) }));
vi.mock('@/lib/notifications/store', () => ({ notify: async (n: { title: string }) => { notices.push(n.title); return true; } }));
vi.mock('@/lib/audit/logger', () => ({ logAudit: async () => undefined }));
vi.mock('@/lib/widgets/runtime/execute', () => ({ loadDataset: async () => ({ data: [{ name: 'bosun', source: stackSource }] }) }));
vi.mock('./client', () => ({ listStacks: async () => (portainerHas ? [{ Id: 4, Name: 'bosun' }] : []) }));
vi.mock('./import', () => ({
  stackManager: async () => ({ spec: { stacks: { list: 'stacks' } } }),
  detachStack: async (_a: unknown, _s: string, _l: unknown, name: string) => { calls.push(`detach ${name}`); return 'It was removed from Portainer and started again from Bosun\'s copy.'; },
}));

const base = { name: 'bosun', serverId: 's1', running: true, user: { id: 'u1', username: 'lango' } };

beforeEach(() => { config.clear(); notices.length = 0; calls.length = 0; stackSource = 'external'; portainerHas = true; userAdmin = true; });

describe('importing this node\'s own stack', () => {
  it('waits until Bosun\'s copy runs the stack, then reports once and forgets it', async () => {
    const { beginSelfImport, advanceSelfImport } = await import('./self-import');
    expect(await beginSelfImport({ ...base, detach: false, portainer: null })).toBe(true);
    expect(await beginSelfImport({ ...base, detach: false, portainer: null })).toBe(false); // one at a time
    await advanceSelfImport();
    expect(notices).toEqual([]); // still external: not yet
    stackSource = 'editor';
    await Promise.all([advanceSelfImport(), advanceSelfImport()]); // the old and the restarted process at once
    expect(notices).toEqual(['Imported bosun into Bosun']);
    expect(config.size).toBe(0);
  });

  it('detaches after the import; the restarted process reports whether Portainer let go', async () => {
    const { beginSelfImport, advanceSelfImport, selfKey } = await import('./self-import');
    await beginSelfImport({ ...base, detach: true, portainer: { id: 4, endpointId: 2 } });
    stackSource = 'git';
    // Portainer's delete normally ends this process mid-call: make the detach never return.
    const imp = await import('./import');
    const real = imp.detachStack;
    (imp as { detachStack: unknown }).detachStack = () => new Promise(() => undefined);
    void advanceSelfImport();
    await new Promise(r => setTimeout(r, 20));
    expect(JSON.parse(config.get(selfKey())!).phase).toBe('detaching');
    (imp as { detachStack: unknown }).detachStack = real;
    // ...the waiter starts Bosun again; Portainer no longer lists it
    portainerHas = false;
    await advanceSelfImport();
    expect(notices).toEqual(['Imported bosun and detached it']);
    expect(config.size).toBe(0);
  });

  it('when the detach returns (Bosun was not stopped), that process reports it', async () => {
    const { beginSelfImport, advanceSelfImport } = await import('./self-import');
    await beginSelfImport({ ...base, detach: true, portainer: { id: 4, endpointId: 2 } });
    stackSource = 'editor';
    await advanceSelfImport();
    expect(calls).toEqual(['detach bosun']);
    expect(notices).toEqual(['Imported bosun and detached it']);
    expect(config.size).toBe(0);
  });

  it('says so when Portainer still lists it, when the asker lost Full access, or after an hour without success', async () => {
    const { beginSelfImport, advanceSelfImport, selfKey } = await import('./self-import');
    config.set(selfKey(), JSON.stringify({ ...base, detach: true, portainer: { id: 4, endpointId: 2 }, phase: 'detaching', at: new Date().toISOString() }));
    await advanceSelfImport();
    expect(notices.pop()).toBe('Imported bosun; detaching is unconfirmed');

    userAdmin = false;
    stackSource = 'editor';
    await beginSelfImport({ ...base, detach: true, portainer: { id: 4, endpointId: 2 } });
    await advanceSelfImport();
    expect(calls).toEqual([]);
    expect(notices.pop()).toBe('Imported bosun; not detached');

    config.set(selfKey(), JSON.stringify({ ...base, detach: false, portainer: null, phase: 'deploying', at: new Date(Date.now() - 2 * 3600_000).toISOString() }));
    await advanceSelfImport();
    expect(notices.pop()).toBe('Importing bosun did not finish');
    expect(config.size).toBe(0);
  });
});
