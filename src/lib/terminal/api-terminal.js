'use strict';

/**
 * Pure helpers for the API terminal (`/ws/api-terminal`), shared by the token route,
 * ws-server.js and the tests. No I/O.
 *
 * The API terminal is deliberately a separate path from the web terminal: it uses a
 * different token type, a different WebSocket route and different SSH credentials
 * (the host's non-admin shell account, or a fixed `docker exec` into one container).
 * Nothing in it can reach the privileged service account's shell, and there is no
 * fallback to it: when something cannot be proven safe the session is refused.
 */

/** Token type for API terminal sessions. The web terminal only accepts `ws`, this only `ws-svc`. */
const TOKEN_TYPE = 'ws-svc';
const TOKEN_TTL_SEC = 60;

/** Container names/IDs accepted for `docker exec` terminals. */
const CONTAINER_REF_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

const MAX_SESSION_MS = 60 * 60 * 1000;
const IDLE_MS = 10 * 60 * 1000;
const MAX_SESSIONS_PER_KEY = 3;

/**
 * Check the claims of a verified `ws-svc` token. Returns `{ ok: true, claims }` or `{ ok: false, reason }`.
 * @param {any} payload
 */
function checkApiTerminalClaims(payload) {
  if (!payload || payload.type !== TOKEN_TYPE) return { ok: false, reason: 'wrong token type' };
  if (payload.authType !== 'api_key' || !String(payload.userId || '').startsWith('apikey:')) return { ok: false, reason: 'not an API key token' };
  if (typeof payload.serverId !== 'string' || !payload.serverId) return { ok: false, reason: 'no server' };
  if (typeof payload.jti !== 'string' || !payload.jti) return { ok: false, reason: 'no token id' };
  if (payload.target !== 'host' && payload.target !== 'container') return { ok: false, reason: 'unknown target' };
  if (payload.target === 'container' && !CONTAINER_REF_RE.test(String(payload.container || ''))) return { ok: false, reason: 'invalid container' };
  if (payload.target === 'host' && payload.container) return { ok: false, reason: 'host token with a container' };
  return { ok: true };
}

/** Tokens are single use: remembers ids until they would have expired anyway. */
class UsedTokens {
  constructor() { this.map = new Map(); }
  /** @returns {boolean} true the first time an id is seen, false for a replay */
  consume(jti, expSec, nowMs = Date.now()) {
    for (const [k, v] of this.map) if (v < nowMs) this.map.delete(k);
    if (this.map.has(jti)) return false;
    this.map.set(jti, (Number(expSec) || 0) * 1000 + 1000);
    return true;
  }
}

/** Caps concurrent API terminals per API key. */
class SessionLimiter {
  constructor(max = MAX_SESSIONS_PER_KEY) { this.max = max; this.counts = new Map(); }
  acquire(key) {
    const n = this.counts.get(key) || 0;
    if (n >= this.max) return false;
    this.counts.set(key, n + 1);
    return true;
  }
  release(key) {
    const n = (this.counts.get(key) || 0) - 1;
    if (n <= 0) this.counts.delete(key); else this.counts.set(key, n);
  }
}

/** Host paths a container must not mount: root, secrets, other users' homes, the Docker socket, kernel interfaces. */
const SENSITIVE_MOUNT_ROOTS = ['/', '/etc', '/root', '/home', '/var/run', '/run', '/var/lib/docker', '/proc', '/sys', '/dev', '/boot', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/var/lib/containerd'];
const DANGEROUS_CAPS = ['ALL', 'SYS_ADMIN', 'SYS_PTRACE', 'SYS_MODULE', 'SYS_RAWIO', 'SYS_BOOT', 'DAC_READ_SEARCH', 'MKNOD', 'BPF', 'PERFMON', 'SYS_CHROOT'];

function normPath(p) {
  const parts = [];
  for (const seg of String(p).split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop(); else parts.push(seg);
  }
  return '/' + parts.join('/');
}

/** True when a bind mount source is one of the sensitive roots or inside one (the filesystem root counts as everything). */
function isSensitiveMount(source) {
  const p = normPath(source);
  if (/docker\.sock$|containerd\.sock$|crio\.sock$|podman\.sock$/i.test(p)) return true;
  if (p === '/') return true;
  return SENSITIVE_MOUNT_ROOTS.some(r => r !== '/' && (p === r || p.startsWith(r + '/')));
}

/**
 * Why a container must NOT get an API shell: anything that would let a root shell inside it
 * reach the host (and from there the admin account). Empty list = acceptable. Unknown shapes
 * are reported as problems: an inspection we cannot read is never treated as safe.
 * @param {any} inspect one element of `docker inspect` output
 * @returns {string[]}
 */
function containerRisks(inspect) {
  const risks = [];
  if (!inspect || typeof inspect !== 'object' || !inspect.HostConfig || !inspect.State) return ['the container could not be inspected'];
  const hc = inspect.HostConfig;
  if (!inspect.State.Running) risks.push('it is not running');
  if (hc.Privileged) risks.push('it is privileged');
  if (hc.PidMode === 'host' || /^container:/.test(String(hc.PidMode || ''))) risks.push('it shares the host (or another container) PID namespace');
  if (hc.IpcMode === 'host') risks.push('it shares the host IPC namespace');
  if (hc.UTSMode === 'host') risks.push('it shares the host UTS namespace');
  if (hc.UsernsMode === 'host') risks.push('it disables user-namespace isolation');
  if (hc.CgroupnsMode === 'host') risks.push('it shares the host cgroup namespace');
  const caps = (hc.CapAdd || []).map(c => String(c).toUpperCase().replace(/^CAP_/, ''));
  const badCaps = caps.filter(c => DANGEROUS_CAPS.includes(c));
  if (badCaps.length) risks.push(`it has dangerous capabilities (${badCaps.join(', ')})`);
  if ((hc.Devices || []).length) risks.push('it has host devices attached');
  if ((hc.DeviceCgroupRules || []).length) risks.push('it has device cgroup rules');
  const sec = (hc.SecurityOpt || []).map(s => String(s).toLowerCase());
  if (sec.some(s => /unconfined|label[:=]disable|systempaths/.test(s))) risks.push('its security profile is disabled');
  const mounts = Array.isArray(inspect.Mounts) ? inspect.Mounts : [];
  for (const m of mounts) {
    if (m && m.Type === 'bind' && isSensitiveMount(m.Source || '')) risks.push(`it mounts the host path ${m.Source}`);
  }
  for (const b of (hc.Binds || [])) {
    const src = String(b).split(':')[0];
    if (src.startsWith('/') && isSensitiveMount(src)) risks.push(`it mounts the host path ${src}`);
  }
  return Array.from(new Set(risks));
}

/** Parse `docker inspect` output; returns the first object or null. */
function parseInspect(stdout) {
  try {
    const j = JSON.parse(String(stdout));
    return Array.isArray(j) && j.length === 1 && j[0] && typeof j[0] === 'object' ? j[0] : null;
  } catch { return null; }
}

/** `docker inspect` for one container, run with the privileged account to decide whether a shell is allowed. */
function inspectCommand(ref) {
  if (!CONTAINER_REF_RE.test(ref)) throw new Error('invalid container reference');
  return `docker inspect --type container ${ref}`;
}

/** Container ids as printed by `docker inspect` (`.Id`). */
const CONTAINER_ID_RE = /^[0-9a-f]{64}$/;

/**
 * The only command the container terminal ever runs: `docker exec` into one container,
 * addressed by its full id. No host shell is involved.
 */
function dockerExecCommand(containerId) {
  if (!CONTAINER_ID_RE.test(containerId)) throw new Error('invalid container id');
  return `docker exec -it ${containerId} sh -c 'if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi'`;
}

module.exports = {
  TOKEN_TYPE, TOKEN_TTL_SEC, CONTAINER_REF_RE, CONTAINER_ID_RE, MAX_SESSION_MS, IDLE_MS, MAX_SESSIONS_PER_KEY,
  checkApiTerminalClaims, UsedTokens, SessionLimiter, containerRisks, isSensitiveMount, parseInspect, inspectCommand, dockerExecCommand,
};
