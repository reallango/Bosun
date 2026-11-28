/**
 * Server-side PTY sessions for the MCP terminal tools.
 *
 * Sessions live in the Node process that opened them (node-local). In a multi-node cluster an MCP call that lands on
 * another node cannot see a session and answers "Session not found on this node"; the PR explains why this is the
 * simpler correct option. They are not the browser WebSocket terminal: input and output travel through MCP calls.
 *
 * Each session keeps a raw output buffer (ANSI stripped on read) and a headless xterm screen for full-screen programs.
 * Input supports `{ctrl-c}`, `{tab}`, `{enter}`, arrow keys and similar (see CONTROL_KEYS).
 */
import crypto from 'crypto';
import { Terminal } from '@xterm/headless';
import type { TokenPayload } from '@/lib/auth/jwt';
import { rqlite } from '@/lib/db/rqlite-client';
import { logAudit, AuditActions } from '@/lib/audit/logger';
import { loadShellTarget, assertShellAccountSafe } from '@/lib/ssh/shell-target';
import { loadServerTarget } from '@/lib/ssh/connection-pool';
import * as sshHelpers from '@/lib/collect/ssh';
import { CONTAINER_NAME_RE } from '@/lib/exec/run-command';

export type TerminalAccount = 'user' | 'service';

export const MAX_SESSIONS_PER_PRINCIPAL = 4;
export const IDLE_MS = 15 * 60 * 1000;
const QUIET_MS = 250;
const MAX_UNREAD_CHARS = 16_000;
const MAX_BUFFER_CHARS = 1_000_000;
const MAX_INPUT_CHARS = 4_000;

export interface PtyStream {
  on(event: 'data', cb: (data: Buffer | string) => void): unknown;
  on(event: 'close', cb: () => void): unknown;
  on(event: 'error', cb: (error: Error) => void): unknown;
  write(data: string): void;
  setWindow?(rows: number, cols: number): void;
  close?(): void;
}

export interface PtyHandle {
  stream: PtyStream;
  close(): void;
}

export interface Screen {
  write(data: string, cb: () => void): void;
  text(): string;
  dispose?(): void;
}

export interface OpenPtyOptions {
  serverId: string;
  as: TerminalAccount;
  container: string | null;
  cols: number;
  rows: number;
}

export interface TerminalDeps {
  openPty(opts: OpenPtyOptions): Promise<PtyHandle>;
  createScreen(cols: number, rows: number): Screen;
  audit(entry: Parameters<typeof logAudit>[0]): Promise<void>;
  now(): number;
  sleep(ms: number): Promise<void>;
}

export class TerminalError extends Error {
  constructor(message: string, readonly status = 400, readonly code = 'TERMINAL_ERROR') {
    super(message);
  }
}

interface Session {
  id: string;
  owner: string;
  serverId: string;
  as: TerminalAccount;
  container: string | null;
  handle: PtyHandle;
  buffer: string;
  cursor: number;
  screen: Screen;
  screenQueue: Promise<void>;
  lastActivity: number;
  createdAt: number;
  closed: boolean;
  passwordPrompt: boolean;
}

export interface TerminalOutput {
  output: string;
  more: boolean;
  password_required: boolean;
}

export interface OpenResult {
  session_id: string;
  server_id: string;
  as: TerminalAccount;
  container: string | null;
  idle_timeout_sec: number;
}

/** A principal is a person or an API key; sessions belong to exactly one. */
export function principalKey(auth: TokenPayload): string {
  return auth.authType === 'api_key' && auth.apiKeyId ? `apikey:${auth.apiKeyId}` : `user:${String(auth.userId)}`;
}

const CONTROL_KEYS: Record<string, string> = {
  'ctrl-a': '\x01', 'ctrl-b': '\x02', 'ctrl-c': '\x03', 'ctrl-d': '\x04', 'ctrl-e': '\x05',
  'ctrl-f': '\x06', 'ctrl-g': '\x07', 'ctrl-h': '\x08', 'ctrl-i': '\t', 'ctrl-j': '\n', 'ctrl-k': '\x0b', 'ctrl-l': '\x0c', 'ctrl-m': '\r',
  'ctrl-n': '\x0e', 'ctrl-o': '\x0f', 'ctrl-p': '\x10', 'ctrl-q': '\x11', 'ctrl-r': '\x12',
  'ctrl-s': '\x13', 'ctrl-t': '\x14', 'ctrl-u': '\x15', 'ctrl-v': '\x16', 'ctrl-w': '\x17',
  'ctrl-x': '\x18', 'ctrl-y': '\x19', 'ctrl-z': '\x1a',
  tab: '\t', enter: '\r', return: '\r', esc: '\x1b', escape: '\x1b', backspace: '\x7f', bs: '\x7f',
  up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D',
  home: '\x1b[H', end: '\x1b[F', pageup: '\x1b[5~', pagedown: '\x1b[6~', delete: '\x1b[3~',
  space: ' ',
};

/** Expand `{ctrl-c}`, `{enter}`, `{up}`, ... in tool input. Unknown braces are left untouched. */
export function translateInput(input: string): string {
  return input.replace(/\{([a-z0-9-]+)\}/gi, (whole, name: string) => CONTROL_KEYS[name.toLowerCase()] ?? whole);
}

const ANSI_RE = /[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

/** Strip ANSI control sequences so the text an agent reads is plain. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '').replace(/\r/g, '');
}

const PASSWORD_RE = /(\[sudo\]\s*password|^password\s*:|password\s+for\s+[^:\n]+:)/im;

export class TerminalSessionManager {
  private sessions = new Map<string, Session>();
  private sweeper: NodeJS.Timeout | null = null;

  constructor(private readonly deps: TerminalDeps, private readonly opts: { idleMs?: number; maxPerPrincipal?: number } = {}) {}

  private get idleMs(): number { return this.opts.idleMs ?? IDLE_MS; }
  private get maxPerPrincipal(): number { return this.opts.maxPerPrincipal ?? MAX_SESSIONS_PER_PRINCIPAL; }

  /** Open a PTY and register it for `owner`. */
  async open(owner: string, auth: TokenPayload, input: { serverId: string; as: TerminalAccount; container?: string | null; ip?: string }): Promise<OpenResult> {
    void this.sweep();
    const container = input.container?.trim() || null;
    if (container && !CONTAINER_NAME_RE.test(container)) throw new TerminalError('container must be a container name or id', 400, 'INVALID_CONTAINER');
    // A container shell always runs through the service account's docker access.
    const as = container ? 'service' : input.as;
    const count = Array.from(this.sessions.values()).filter(s => s.owner === owner && !s.closed).length;
    if (count >= this.maxPerPrincipal) {
      throw new TerminalError(`Too many open terminal sessions (at most ${this.maxPerPrincipal}); close one first`, 429, 'TOO_MANY_SESSIONS');
    }
    const handle = await this.deps.openPty({ serverId: input.serverId, as, container, cols: 120, rows: 30 });
    const id = crypto.randomUUID();
    const now = this.deps.now();
    const session: Session = {
      id, owner, serverId: input.serverId, as, container, handle,
      buffer: '', cursor: 0, screen: this.deps.createScreen(120, 30), screenQueue: Promise.resolve(),
      lastActivity: now, createdAt: now, closed: false, passwordPrompt: false,
    };
    this.sessions.set(id, session);
    handle.stream.on('data', (data) => this.onData(session, Buffer.isBuffer(data) ? data.toString('utf8') : String(data)));
    handle.stream.on('close', () => { void this.finish(session, 'shell ended'); });
    handle.stream.on('error', () => { void this.finish(session, 'shell error'); });
    this.startSweeper();
    await this.deps.audit({
      userId: auth.userId, serverId: input.serverId, ipAddress: input.ip,
      action: AuditActions.TERMINAL_MCP_OPEN, status: 'success',
      details: `session ${id} as ${as}${container ? ` in container ${container}` : ''}`,
    });
    return { session_id: id, server_id: input.serverId, as, container, idle_timeout_sec: Math.round(this.idleMs / 1000) };
  }

  /** Send input, then return the output that arrives until it goes quiet or wait_ms passes. */
  async send(owner: string, sessionId: string, input: string, waitMs: number, auth: TokenPayload, ip?: string): Promise<TerminalOutput> {
    const session = this.owned(owner, sessionId);
    if (input.length > MAX_INPUT_CHARS) throw new TerminalError(`input is longer than ${MAX_INPUT_CHARS} characters`, 400, 'INPUT_TOO_LONG');
    const translated = translateInput(input);
    session.lastActivity = this.deps.now();
    const masked = session.passwordPrompt;
    await this.deps.audit({
      userId: auth.userId, serverId: session.serverId, ipAddress: ip,
      action: AuditActions.TERMINAL_MCP_INPUT, status: 'success',
      // Only the length is recorded: typed input may be a password or another secret, so it is never written to disk.
      details: `session ${sessionId}: ${translated.length} characters${masked ? ' (masked: password prompt)' : ''}`,
    });
    session.handle.stream.write(translated);
    return this.collect(session, waitMs);
  }

  /** Return further output without sending input. */
  async read(owner: string, sessionId: string, waitMs: number): Promise<TerminalOutput> {
    const session = this.owned(owner, sessionId);
    session.lastActivity = this.deps.now();
    return this.collect(session, waitMs);
  }

  /** The current screen as plain text, from the headless terminal emulator. */
  async screenText(owner: string, sessionId: string): Promise<string> {
    const session = this.owned(owner, sessionId);
    session.lastActivity = this.deps.now();
    await session.screenQueue;
    return session.screen.text();
  }

  /** Close one session. Returns false when it was already closed or is not the caller's. */
  async close(owner: string, sessionId: string, auth?: TokenPayload, ip?: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session || session.owner !== owner || session.closed) return false;
    await this.finish(session, 'closed by caller', auth, ip);
    return true;
  }

  /** Close every idle session. Exposed so tests can advance time deterministically. */
  async sweep(): Promise<number> {
    const now = this.deps.now();
    let closed = 0;
    for (const s of Array.from(this.sessions.values())) {
      if (!s.closed && now - s.lastActivity > this.idleMs) {
        await this.finish(s, 'idle timeout');
        closed += 1;
      }
    }
    return closed;
  }

  /** Test/introspection helper: the number of open sessions for a principal. */
  countFor(owner: string): number {
    return Array.from(this.sessions.values()).filter(s => s.owner === owner && !s.closed).length;
  }

  private owned(owner: string, sessionId: string): Session {
    const session = this.sessions.get(sessionId);
    if (!session || session.closed || session.owner !== owner) {
      throw new TerminalError('Session not found on this node (sessions are node-local and belong to the principal that opened them)', 404, 'SESSION_NOT_FOUND');
    }
    return session;
  }

  private onData(session: Session, text: string): void {
    if (session.closed || !text) return;
    session.buffer += text;
    if (session.buffer.length > MAX_BUFFER_CHARS) {
      const drop = session.buffer.length - Math.floor(MAX_BUFFER_CHARS / 2);
      session.buffer = session.buffer.slice(drop);
      session.cursor = Math.max(0, session.cursor - drop);
    }
    session.screenQueue = session.screenQueue.then(() => new Promise<void>(resolve => session.screen.write(text, resolve)));
    session.lastActivity = this.deps.now();
  }

  private take(session: Session): TerminalOutput {
    const unread = session.buffer.slice(session.cursor);
    const shown = unread.slice(0, MAX_UNREAD_CHARS);
    const more = unread.length > shown.length;
    session.cursor += shown.length;
    const output = stripAnsi(shown);
    const password_required = PASSWORD_RE.test(output);
    session.passwordPrompt = password_required;
    return { output, more, password_required };
  }

  private async collect(session: Session, waitMs: number): Promise<TerminalOutput> {
    const capped = Math.min(Math.max(Math.round(waitMs) || 0, 0), 30_000);
    const start = this.deps.now();
    let lastLength = session.buffer.length;
    let lastChange = start;
    for (;;) {
      const now = this.deps.now();
      if (now - start >= capped) break;
      if (session.buffer.length !== lastLength) {
        lastLength = session.buffer.length;
        lastChange = now;
      } else if (session.buffer.length > session.cursor && now - lastChange >= QUIET_MS) {
        break;
      }
      await this.deps.sleep(Math.min(50, Math.max(1, capped - (now - start))));
    }
    return this.take(session);
  }

  private async finish(session: Session, why: string, auth?: TokenPayload, ip?: string): Promise<void> {
    if (session.closed) return;
    session.closed = true;
    try { session.handle.stream.close?.(); } catch { /* ignore */ }
    try { session.handle.close(); } catch { /* ignore */ }
    try { session.screen.dispose?.(); } catch { /* ignore */ }
    this.sessions.delete(session.id);
    await this.deps.audit({
      userId: auth?.userId, serverId: session.serverId, ipAddress: ip,
      action: AuditActions.TERMINAL_MCP_CLOSE, status: 'success',
      details: `session ${session.id}: ${why}`,
    }).catch(() => undefined);
  }

  private startSweeper(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => { void this.sweep(); }, 60_000);
    this.sweeper.unref?.();
  }
}

function createXtermScreen(cols: number, rows: number): Screen {
  const term = new Terminal({ cols, rows, scrollback: 2000, allowProposedApi: true });
  return {
    write: (data, cb) => term.write(data, cb),
    text: () => {
      const buffer = term.buffer.active;
      const lines: string[] = [];
      for (let i = 0; i < buffer.length; i++) lines.push(buffer.getLine(i)?.translateToString(true) ?? '');
      while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
      return lines.join('\n');
    },
    dispose: () => term.dispose(),
  };
}

async function openSshPty(opts: OpenPtyOptions): Promise<PtyHandle> {
  let config: { host: string; port: number; username: string; privateKey: string; passphrase?: string };
  let platform: 'linux' | 'windows';
  if (opts.as === 'user') {
    const target = await loadShellTarget(opts.serverId);
    await assertShellAccountSafe(target);
    config = target.config;
    platform = target.platform;
  } else {
    const target = await loadServerTarget(opts.serverId);
    config = target.config;
    platform = target.platform;
  }
  if (opts.container && platform === 'windows') throw new TerminalError('Container terminals are not available on Windows hosts', 409, 'SHELL_UNAVAILABLE');

  const fp = await rqlite.query('SELECT host_key_fingerprint FROM servers WHERE id = ?', [opts.serverId]).catch(() => null);
  const expected = (fp?.values?.[0]?.[0] as string | null) || undefined;
  const client = await sshHelpers.connect({
    host: config.host, port: config.port, username: config.username, privateKey: config.privateKey, passphrase: config.passphrase,
    expectedFingerprint: expected,
    onNewFingerprint: (value: string) => { rqlite.execute('UPDATE servers SET host_key_fingerprint = ? WHERE id = ? AND host_key_fingerprint IS NULL', [value, opts.serverId]).catch(() => undefined); },
  });

  const pty = { term: 'xterm-256color', cols: opts.cols, rows: opts.rows };
  const command = opts.container
    ? `docker exec -it ${shq(opts.container)} sh`
    : platform === 'windows' ? 'powershell -NoLogo -NoProfile' : null;
  const stream = await new Promise<PtyStream>((resolve, reject) => {
    const onStream = (err: Error | undefined, value: PtyStream) => (err ? reject(err) : resolve(value));
    if (command) client.exec(command, { pty }, onStream);
    else client.shell(pty, onStream);
  });
  return { stream, close: () => { try { client.end(); } catch { /* ignore */ } } };
}

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

const globalForTerminals = globalThis as unknown as { __bosunMcpTerminals?: TerminalSessionManager };

export function getMcpTerminalManager(): TerminalSessionManager {
  return globalForTerminals.__bosunMcpTerminals ?? (globalForTerminals.__bosunMcpTerminals = new TerminalSessionManager({
    openPty: openSshPty,
    createScreen: createXtermScreen,
    audit: logAudit,
    now: () => Date.now(),
    sleep: (ms) => new Promise<void>(resolve => setTimeout(resolve, ms)),
  }));
}

/** Replace the singleton in tests. */
export function setMcpTerminalManagerForTests(manager: TerminalSessionManager | null): void {
  if (manager) globalForTerminals.__bosunMcpTerminals = manager;
  else delete globalForTerminals.__bosunMcpTerminals;
}
