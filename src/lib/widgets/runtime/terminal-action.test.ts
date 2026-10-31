import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';

const state = vi.hoisted(() => ({
  check: null as null | ((args: Record<string, string>) => { success: boolean; stdout: string; stderr: string; protocol: { error: string | null } }),
  issued: [] as Record<string, unknown>[],
  scripts: [] as Record<string, string>[],
}));

vi.mock('@/lib/widgets/runtime/execute', () => ({
  runScript: async (_s: string, _l: unknown, _id: string, args: Record<string, string>) => { state.scripts.push(args); return state.check!(args); },
}));
vi.mock('@/lib/terminal/api-token', () => ({
  issueApiTerminalToken: async (_a: unknown, serverId: string, target: string, opts: Record<string, unknown>) => { state.issued.push({ kind: 'api', serverId, target, ...opts }); return NextResponse.json({ data: { api: true } }); },
  issueWebCommandToken: async (_a: unknown, serverId: string, command: string, label: string, via: string) => { state.issued.push({ kind: 'web', serverId, command, label, via }); return NextResponse.json({ data: { web: true } }); },
}));
vi.mock('@/lib/utils/rate-limiter', () => ({ consumeActionRateLimit: () => ({ allowed: true }) }));

import { openTerminalAction, SAFE_REF_RE } from './terminal-action';

const loaded = { type: 'dk_w', packageId: 'dk', spec: {}, network: [] } as never;
const action = (over: Record<string, unknown> = {}) => ({
  id: 'shell', label: 'Shell', permission: 'dk.shell', kind: 'terminal',
  terminal: { ref: 'name', refPattern: '^[a-z][a-z0-9_.-]{0,40}$', command: 'docker exec -it {{ref}} sh', check: 'shell_check', ...over },
}) as never;
const api = { userId: 'apikey:k', authType: 'api_key', apiKeyId: 'k', role: 'viewer' } as never;
const admin = { userId: 'u1', authType: 'session', role: 'admin' } as never;
const operator = { userId: 'u2', authType: 'session', role: 'operator' } as never;
const body = async (r: NextResponse) => ({ status: r.status, json: await r.json() });

beforeEach(() => { state.issued = []; state.scripts = []; state.check = () => ({ success: true, stdout: 'REF abc123\nDONE ok\n', stderr: '', protocol: { error: null } }); });

describe('SAFE_REF_RE', () => {
  it('lets names through and nothing that could change a command line', () => {
    for (const ok of ['web', 'web-1', 'a.b_c', 'ns:name@x', 'a'.repeat(200)]) expect(SAFE_REF_RE.test(ok), ok).toBe(true);
    for (const bad of ['', '-rf', 'a b', 'a;b', 'a$(id)', "a'b", 'a"b', 'a\nb', '`id`', 'a|b', 'a&b', 'a/b', 'a'.repeat(201)]) expect(SAFE_REF_RE.test(bad), bad).toBe(false);
  });
});

describe('opening a package terminal', () => {
  it('refuses a target that is not an acceptable name, whatever the package pattern allows', async () => {
    for (const ref of ['', undefined, 5, 'Web', 'a b', 'web;id', '-x', 'x'.repeat(60)]) {
      const r = await body(await openTerminalAction(api, 's1', loaded, action(), ref));
      expect(r.status, String(ref)).toBe(400);
    }
    // a pattern that is wider than the safe set is still held to the safe set
    const wide = await body(await openTerminalAction(admin, 's1', loaded, action({ refPattern: '^.+$' }), 'a b'));
    expect(wide.status).toBe(400);
    expect(state.issued).toEqual([]);
  });

  it('API keys pass the check first, and the command uses the target the check pinned', async () => {
    const r = await openTerminalAction(api, 's1', loaded, action(), 'web');
    expect(r.status).toBe(200);
    expect(state.scripts).toEqual([{ ref: 'web' }]);
    expect(state.issued).toEqual([{ kind: 'api', serverId: 's1', target: 'command', command: 'docker exec -it abc123 sh', label: 'Shell: web', via: 'dk_w/shell' }]);
  });

  it('API keys without a pin get the target they asked for; without a check nothing is run', async () => {
    state.check = () => ({ success: true, stdout: 'DONE ok\n', stderr: '', protocol: { error: null } });
    await openTerminalAction(api, 's1', loaded, action(), 'web');
    expect(state.issued[0].command).toBe('docker exec -it web sh');
    state.issued = []; state.scripts = [];
    await openTerminalAction(api, 's1', loaded, action({ check: undefined }), 'web');
    expect(state.scripts).toEqual([]);
    expect(state.issued[0].command).toBe('docker exec -it web sh');
  });

  it('refuses when the check refuses or fails, and mints nothing', async () => {
    state.check = () => ({ success: true, stdout: 'ERROR: it is privileged\n', stderr: '', protocol: { error: 'it is privileged' } });
    const r = await body(await openTerminalAction(api, 's1', loaded, action(), 'web'));
    expect(r.status).toBe(403);
    expect(r.json.error.message).toMatch(/it is privileged/);
    state.check = () => ({ success: false, stdout: '', stderr: 'boom', protocol: { error: null } });
    expect((await openTerminalAction(api, 's1', loaded, action(), 'web')).status).toBe(403);
    expect(state.issued).toEqual([]);
  });

  it('refuses a pin that is not an acceptable name', async () => {
    for (const pin of ['a b', 'x;id', '-rf', '$(id)']) {
      state.check = () => ({ success: true, stdout: `REF ${pin}\nDONE ok\n`, stderr: '', protocol: { error: null } });
      expect((await openTerminalAction(api, 's1', loaded, action(), 'web')).status, pin).toBe(403);
    }
    expect(state.issued).toEqual([]);
  });

  it('a signed-in Full access user gets a web terminal token (no check: they type their own login), others are refused', async () => {
    const ok = await openTerminalAction(admin, 's1', loaded, action(), 'web');
    expect(ok.status).toBe(200);
    expect(state.scripts).toEqual([]);
    expect(state.issued).toEqual([{ kind: 'web', serverId: 's1', command: 'docker exec -it web sh', label: 'Shell: web', via: 'dk_w/shell' }]);
    state.issued = [];
    expect((await openTerminalAction(operator, 's1', loaded, action(), 'web')).status).toBe(403);
    expect(state.issued).toEqual([]);
  });

  it('an action that is not a terminal is not opened', async () => {
    const r = await openTerminalAction(admin, 's1', loaded, { id: 'x', kind: 'script' } as never, 'web');
    expect(r.status).toBe(400);
  });
});
