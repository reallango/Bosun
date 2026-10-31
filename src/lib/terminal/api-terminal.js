'use strict';

/**
 * Pure helpers for the API terminal (`/ws/api-terminal`), shared by the token route,
 * ws-server.js and the tests. No I/O.
 *
 * The API terminal is deliberately a separate path from the web terminal: it uses a
 * different token type, a different WebSocket route and different SSH credentials
 * (the host's non-admin shell account, or the one command a package's terminal action declared).
 * Nothing in it can reach the privileged service account's shell, and there is no
 * fallback to it: when something cannot be proven safe the session is refused.
 */

/** Token type for API terminal sessions. The web terminal only accepts `ws`, this only `ws-svc`. */
const TOKEN_TYPE = 'ws-svc';
const TOKEN_TTL_SEC = 60;

/** Token type for web terminal sessions that run a package's command (minted for a signed-in Full access user). */
const WEB_CMD_TOKEN_TYPE = 'ws-cmd';

/**
 * A command a package's terminal action may run: one line, no control characters. It is the command the package declared
 * with the checked target put in; Bosun never builds it from anything else.
 */
const MAX_COMMAND_LENGTH = 2000;
function isValidTerminalCommand(cmd) {
  return typeof cmd === 'string' && cmd.length > 0 && cmd.length <= MAX_COMMAND_LENGTH && !/[\u0000-\u001f\u007f]/.test(cmd);
}
const isValidLabel = (s) => typeof s === 'string' && s.length > 0 && s.length <= 200 && !/[\u0000-\u001f\u007f]/.test(s);

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
  if (payload.target !== 'host' && payload.target !== 'command') return { ok: false, reason: 'unknown target' };
  if (payload.target === 'command' && (!isValidTerminalCommand(payload.cmd) || !isValidLabel(payload.label))) return { ok: false, reason: 'invalid command' };
  if (payload.target === 'host' && (payload.cmd || payload.label)) return { ok: false, reason: 'host token with a command' };
  return { ok: true };
}

/**
 * Check the claims of a verified `ws-cmd` token (web terminal): minted for this signed-in user and this server, single use.
 * @param {any} payload the command token
 * @param {any} access the user's own access token (the one that authenticates the WebSocket)
 */
function checkWebCommandClaims(payload, access) {
  if (!payload || payload.type !== WEB_CMD_TOKEN_TYPE) return { ok: false, reason: 'wrong token type' };
  if (!access || payload.userId !== access.userId) return { ok: false, reason: 'minted for someone else' };
  if (payload.authType === 'api_key' || String(payload.userId || '').startsWith('apikey:')) return { ok: false, reason: 'API keys have no web terminal' };
  if (typeof payload.serverId !== 'string' || !payload.serverId) return { ok: false, reason: 'no server' };
  if (typeof payload.jti !== 'string' || !payload.jti) return { ok: false, reason: 'no token id' };
  if (!isValidTerminalCommand(payload.cmd) || !isValidLabel(payload.label)) return { ok: false, reason: 'invalid command' };
  return { ok: true };
}


/** app_config keys behind the limits (editable under Settings → Database). */
const LIMIT_KEYS = {
  tokenTtlSec: 'terminal.api.token_ttl_sec',
  sessionMaxMin: 'terminal.api.session_max_min',
  idleMin: 'terminal.api.idle_min',
  maxPerKey: 'terminal.api.max_per_key',
};
const LIMIT_RANGES = {
  tokenTtlSec: { def: TOKEN_TTL_SEC, min: 10, max: 300 },
  sessionMaxMin: { def: MAX_SESSION_MS / 60000, min: 1, max: 1440 },
  idleMin: { def: IDLE_MS / 60000, min: 1, max: 240 },
  maxPerKey: { def: MAX_SESSIONS_PER_KEY, min: 1, max: 20 },
};

/**
 * Turn stored setting values into usable limits: missing, non-numeric or out-of-range
 * values fall back to the default or are clamped, so a bad setting can never disable a limit.
 * @param {Record<string, string|number|null|undefined>} stored keyed by app_config key
 */
function terminalLimits(stored = {}) {
  const pick = (name) => {
    const r = LIMIT_RANGES[name];
    const n = Math.round(Number(stored[LIMIT_KEYS[name]]));
    return Number.isFinite(n) && stored[LIMIT_KEYS[name]] !== null && stored[LIMIT_KEYS[name]] !== undefined && stored[LIMIT_KEYS[name]] !== ''
      ? Math.min(r.max, Math.max(r.min, n)) : r.def;
  };
  return {
    tokenTtlSec: pick('tokenTtlSec'),
    maxSessionMs: pick('sessionMaxMin') * 60000,
    idleMs: pick('idleMin') * 60000,
    maxPerKey: pick('maxPerKey'),
  };
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
  /** @param {string} key @param {number} [max] overrides the default cap (from the settings) */
  acquire(key, max = this.max) {
    const n = this.counts.get(key) || 0;
    if (n >= max) return false;
    this.counts.set(key, n + 1);
    return true;
  }
  release(key) {
    const n = (this.counts.get(key) || 0) - 1;
    if (n <= 0) this.counts.delete(key); else this.counts.set(key, n);
  }
}

module.exports = {
  TOKEN_TYPE, WEB_CMD_TOKEN_TYPE, TOKEN_TTL_SEC, MAX_COMMAND_LENGTH, MAX_SESSION_MS, IDLE_MS, MAX_SESSIONS_PER_KEY,
  LIMIT_KEYS, terminalLimits, checkApiTerminalClaims, checkWebCommandClaims, isValidTerminalCommand, UsedTokens, SessionLimiter,
};
