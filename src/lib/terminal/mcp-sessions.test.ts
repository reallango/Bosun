import { describe, expect, it } from 'vitest';
import {
  IDLE_MS, MAX_SESSIONS_PER_PRINCIPAL, TerminalError, TerminalSessionManager,
  stripAnsi, translateInput, type OpenPtyOptions, type PtyHandle, type Screen, type TerminalDeps,
} from './mcp-sessions';

class FakeStream {
  written: string[] = [];
  closed = false;
  onWrite: ((data: string) => void) | null = null;
  private data: Array<(d: Buffer | string) => void> = [];
  private closeListeners: Array<() => void> = [];
  private errors: Array<(e: Error) => void> = [];
  on(event: 'data' | 'close' | 'error', cb: (...args: never[]) => void): this {
    if (event === 'data') this.data.push(cb as (d: Buffer | string) => void);
    else if (event === 'close') this.closeListeners.push(cb as () => void);
    else this.errors.push(cb as (e: Error) => void);
    return this;
  }
  write(text: string): void { this.written.push(text); this.onWrite?.(text); }
  closeStream(): void { this.closed = true; this.closeListeners.forEach(cb => cb()); }
  emit(data: string): void { this.data.forEach(cb => cb(data)); }
}

function fakeDeps() {
  const state = {
    now: 1_000,
    audits: [] as Array<Record<string, unknown>>,
    opens: [] as OpenPtyOptions[],
    screens: [] as Screen[],
    lastStream: null as FakeStream | null,
  };
  const deps: TerminalDeps = {
    now: () => state.now,
    sleep: async (ms) => { state.now += Math.max(1, ms); },
    audit: async (entry) => { state.audits.push(entry as unknown as Record<string, unknown>); },
    createScreen: () => {
      let text = '';
      const screen: Screen = { write: (data, cb) => { text += stripAnsi(data); cb(); }, text: () => text.trimEnd() };
      state.screens.push(screen);
      return screen;
    },
    openPty: async (opts) => {
      state.opens.push(opts);
      const stream = new FakeStream();
      const handle: PtyHandle = { stream, close: () => { /* the SSH client */ } };
      state.lastStream = stream;
      return handle;
    },
  };
  const stream = () => {
    if (!state.lastStream) throw new Error('open a session first');
    return state.lastStream;
  };
  return { deps, state, stream };
}

const auth = (id = 'u1') => ({ userId: id, username: `user-${id}`, role: 'operator', authType: 'user' } as never);

describe('terminal sessions', () => {
  it('opens, sends (with control keys), reads, shows the screen and closes', async () => {
    const { deps, state, stream } = fakeDeps();
    const manager = new TerminalSessionManager(deps);
    const opened = await manager.open('user:u1', auth(), { serverId: 'srv-1', as: 'user' });
    expect(opened.session_id).toBeTruthy();
    expect(opened.idle_timeout_sec).toBe(Math.round(IDLE_MS / 1000));
    expect(state.opens[0]).toMatchObject({ serverId: 'srv-1', as: 'user', container: null });
    expect(manager.countFor('user:u1')).toBe(1);
    expect(state.audits.some(a => a.action === 'terminal.mcp_open')).toBe(true);

    stream().onWrite = () => stream().emit('\u001b[31mhello\u001b[0m\r\n');
    const sent = await manager.send('user:u1', opened.session_id, 'ls{enter}', 1_000, auth(), '127.0.0.1');
    expect(stream().written).toEqual(['ls\r']);
    expect(sent.output).toBe('hello\n');
    expect(sent.more).toBe(false);
    expect(sent.password_required).toBe(false);

    stream().emit('second line\n');
    const read = await manager.read('user:u1', opened.session_id, 0);
    expect(read.output).toBe('second line\n');

    const screen = await manager.screenText('user:u1', opened.session_id);
    expect(screen).toContain('hello');
    expect(screen).toContain('second line');

    expect(await manager.close('user:u1', opened.session_id, auth(), '127.0.0.1')).toBe(true);
    expect(manager.countFor('user:u1')).toBe(0);
    expect(state.audits.some(a => a.action === 'terminal.mcp_close')).toBe(true);
    await expect(manager.read('user:u1', opened.session_id, 0)).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
  });

  it('translates documented control keys and leaves unknown braces alone', () => {
    expect(translateInput('{ctrl-c}{tab}{up}{down}{left}{right}{home}{end}{enter}{esc}{backspace}')).toBe('\x03\t\x1b[A\x1b[B\x1b[D\x1b[C\x1b[H\x1b[F\r\x1b\x7f');
    expect(translateInput('echo {not-a-key}')).toBe('echo {not-a-key}');
  });

  it('strips ANSI escapes and carriage returns', () => {
    expect(stripAnsi('\u001b[1;32mok\u001b[0m\r\n')).toBe('ok\n');
  });

  it('flags a password prompt and masks later input in the audit log', async () => {
    const { deps, state, stream } = fakeDeps();
    const manager = new TerminalSessionManager(deps);
    const opened = await manager.open('user:u1', auth(), { serverId: 'srv-1', as: 'user' });
    stream().emit('[sudo] password for deploy: ');
    const first = await manager.send('user:u1', opened.session_id, '', 0, auth());
    expect(first.password_required).toBe(true);

    await manager.send('user:u1', opened.session_id, 'hunter2{enter}', 0, auth());
    const input = state.audits.filter(a => a.action === 'terminal.mcp_input').at(-1)!;
    expect(String(input.details)).toContain('masked: password prompt');
    expect(String(input.details)).not.toContain('hunter2');
  });

  it('enforces ownership', async () => {
    const { deps } = fakeDeps();
    const manager = new TerminalSessionManager(deps);
    const opened = await manager.open('user:u1', auth('u1'), { serverId: 'srv-1', as: 'user' });
    await expect(manager.send('user:u2', opened.session_id, 'id', 0, auth('u2'))).rejects.toBeInstanceOf(TerminalError);
    await expect(manager.screenText('user:u2', opened.session_id)).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
    expect(await manager.close('user:u2', opened.session_id)).toBe(false);
    expect(manager.countFor('user:u1')).toBe(1);
  });

  it('caps sessions per principal', async () => {
    const { deps } = fakeDeps();
    const manager = new TerminalSessionManager(deps);
    for (let i = 0; i < MAX_SESSIONS_PER_PRINCIPAL; i++) {
      await manager.open('user:u1', auth(), { serverId: 'srv-1', as: 'user' });
    }
    await expect(manager.open('user:u1', auth(), { serverId: 'srv-1', as: 'user' })).rejects.toMatchObject({ status: 429, code: 'TOO_MANY_SESSIONS' });
    // Another principal is unaffected.
    await expect(manager.open('user:u2', auth('u2'), { serverId: 'srv-1', as: 'user' })).resolves.toBeTruthy();
  });

  it('closes idle sessions on the next sweep', async () => {
    const { deps, state, stream } = fakeDeps();
    const manager = new TerminalSessionManager(deps, { idleMs: 1_000 });
    const opened = await manager.open('user:u1', auth(), { serverId: 'srv-1', as: 'user' });
    state.now += 1_500;
    expect(await manager.sweep()).toBe(1);
    expect(manager.countFor('user:u1')).toBe(0);
    const close = state.audits.filter(a => a.action === 'terminal.mcp_close').at(-1)!;
    expect(String(close.details)).toContain('idle timeout');
    await expect(manager.read('user:u1', opened.session_id, 0)).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
  });

  it('reports when more output is waiting', async () => {
    const { deps, state, stream } = fakeDeps();
    const manager = new TerminalSessionManager(deps);
    const opened = await manager.open('user:u1', auth(), { serverId: 'srv-1', as: 'user' });
    stream().emit('x'.repeat(20_000));
    const out = await manager.read('user:u1', opened.session_id, 0);
    expect(out.more).toBe(true);
    expect(out.output.length).toBeGreaterThan(0);
    const rest = await manager.read('user:u1', opened.session_id, 0);
    expect(rest.output.length).toBeGreaterThan(0);
  });
});
