'use strict';

/**
 * The API terminal WebSocket session (`/ws/api-terminal`), used by ws-server.js.
 *
 * Why this is not the web terminal: the web terminal logs in with the person's own typed
 * account and password. This one is for API keys and uses only credentials Bosun holds for
 * a deliberately weak purpose:
 *   - host target:      the host's NON-ADMIN shell account (its own key; no sudo, no Docker group),
 *                       re-verified on every open;
 *   - command target:   the one command a package's terminal action declared, over the privileged account,
 *                       and only after the package's own check passed when the token was minted. The
 *                       privileged account runs exactly that command; it never
 *                       gets a shell, and the session ends the moment that exec ends.
 * There is no reattach, no fallback to another account, and no way to type commands into
 * anything but the shell/exec the session was opened for.
 */

const WebSocket = require('ws');
const { connect: sshConnect, exec: sshExec, decryptSecret } = require('../collect/ssh');
const { getMasterKey } = require('../secrets');
const api = require('./api-terminal');
const { SHELL_VERIFY_COMMAND, parseShellVerification } = require('../ssh/shell-account');
const { WINDOWS_SHELL_VERIFY_COMMAND, parseWindowsShellVerification } = require('../ssh/windows-shell-account');
const { powershellCommand } = require('../collect/windows');

const usedTokens = new api.UsedTokens();
const limiter = new api.SessionLimiter();

function refuse(ws, code, message) {
  try { ws.send('\r\n*** ' + message + ' ***\r\n'); } catch { /* closed */ }
  try { ws.close(code, message.slice(0, 120)); } catch { /* closed */ }
}

/**
 * @param {import('ws')} ws
 * @param {URL|{query:any}} parsedUrl url.parse(..., true) result
 * @param {{ verifyToken: (t: string, type: string) => any, queryRqlite: Function, audit: Function, clientIP: string }} deps
 */
async function handleApiTerminal(ws, parsedUrl, deps) {
  const { verifyToken, queryRqlite, audit, clientIP } = deps;
  const token = parsedUrl.query.token;
  if (!token) return refuse(ws, 4001, 'Missing token');
  const payload = verifyToken(token, api.TOKEN_TYPE);
  if (!payload) return refuse(ws, 4001, 'Invalid token');
  const checked = api.checkApiTerminalClaims(payload);
  if (!checked.ok) return refuse(ws, 4003, 'Insufficient permissions');
  if (!usedTokens.consume(payload.jti, payload.exp)) return refuse(ws, 4001, 'Token already used');
  // Limits come from the settings (Settings → Database); a failed read falls back to the defaults.
  let stored = {};
  try {
    const keys = Object.values(api.LIMIT_KEYS);
    const rows = await queryRqlite('SELECT key, value FROM app_config WHERE key IN (' + keys.map(() => '?').join(',') + ')', keys);
    for (const [k, v] of rows) stored[k] = v;
  } catch { stored = {}; }
  const limits = api.terminalLimits(stored);
  if (!limiter.acquire(payload.apiKeyId, limits.maxPerKey)) return refuse(ws, 4000, 'Too many open terminals for this API key');

  let released = false;
  let client = null;
  let stream = null;
  let maxTimer = null;
  let idleTimer = null;
  let detail = payload.target === 'host' ? 'host shell' : String(payload.label);
  let opened = false;
  const startedAt = Date.now();

  const finish = (why) => {
    if (released) return;
    released = true;
    clearTimeout(maxTimer);
    clearTimeout(idleTimer);
    limiter.release(payload.apiKeyId);
    try { if (stream) stream.close(); } catch { /* ignore */ }
    try { if (client) client.end(); } catch { /* ignore */ }
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      try { ws.close(); } catch { /* ignore */ }
    }
    if (opened) {
      audit({ userId: payload.userId, serverId: payload.serverId, action: 'terminal.api_close', status: 'success',
        details: `${detail}; ${why}`, ip: clientIP, durationMs: Date.now() - startedAt });
    }
  };
  ws.on('close', () => finish('client disconnected'));
  ws.on('error', () => finish('socket error'));

  try {
    // The key must still be active (the token lives 60 s; a revoke should bite at once).
    const keyRow = await queryRqlite('SELECT revoked_at, expires_at FROM api_keys WHERE id = ?', [payload.apiKeyId]);
    if (!keyRow.length || keyRow[0][0]) return fail('API key is no longer active', 4003);
    if (keyRow[0][1] && new Date(String(keyRow[0][1]).replace(' ', 'T') + (String(keyRow[0][1]).endsWith('Z') ? '' : 'Z')).getTime() <= Date.now()) return fail('API key is no longer active', 4003);

    const s = await queryRqlite('SELECT hostname, ssh_port, platform, host_key_fingerprint, ssh_user, ssh_key_id, shell_user, shell_key_id FROM servers WHERE id = ?', [payload.serverId]);
    if (!s.length) return fail('Server not found', 4000);
    const [hostname, port, platform, fingerprint, sshUser, sshKeyId, shellUser, shellKeyId] = s[0];
    const isWindows = platform === 'windows';
    if (isWindows && payload.target !== 'host') return fail('This terminal is not available on Windows hosts', 4000);

    // Which key and account does this session use? Exactly one, fixed by the token's target.
    const isHost = payload.target === 'host';
    const account = isHost ? shellUser : sshUser;
    const keyId = isHost ? shellKeyId : sshKeyId;
    if (!account || !keyId) return fail(isHost ? 'No non-admin shell account on this server' : 'No SSH key on this server', 4000);
    const k = await queryRqlite('SELECT private_key_enc, passphrase_enc FROM ssh_keys WHERE id = ?', [keyId]);
    if (!k.length) return fail('SSH key not found', 4000);
    const masterKey = getMasterKey();

    client = await sshConnect({
      host: hostname, port: Number(port) || 22, username: account,
      privateKey: decryptSecret(String(k[0][0]), masterKey),
      passphrase: k[0][1] ? decryptSecret(String(k[0][1]), masterKey) : undefined,
      expectedFingerprint: fingerprint || undefined,
    });
    client.on('error', () => finish('ssh error'));
    client.on('close', () => finish('ssh closed'));

    let command = null;
    if (isHost) {
      // Prove, on every open, that the account still has no admin rights.
      const v = await sshExec(client, isWindows ? powershellCommand(WINDOWS_SHELL_VERIFY_COMMAND) : SHELL_VERIFY_COMMAND, { timeoutMs: isWindows ? 30000 : 15000 });
      const verdict = isWindows ? parseWindowsShellVerification(v.stdout, account) : parseShellVerification(v.stdout, account);
      if (!verdict.ok) return fail('The shell account is not safe to use: ' + verdict.problems.join('; '), 4003);
      // Windows: an interactive PowerShell on a PTY (client.shell() would start cmd.exe). Still the same
      // non-admin account, and nothing else is run.
      if (isWindows) command = 'powershell -NoLogo -NoProfile';
    } else {
      // The privileged account runs exactly the command the package's terminal action declared and its check pinned (it
      // is in the signed token); nothing else, and no host shell behind it.
      command = String(payload.cmd);
    }

    const pty = { term: 'xterm-256color', cols: 80, rows: 24 };
    await new Promise((resolve, reject) => {
      const onStream = (err, st) => (err ? reject(err) : (stream = st, resolve()));
      if (command) client.exec(command, { pty }, onStream);
      else client.shell(pty, onStream);
    });

    opened = true;
    audit({ userId: payload.userId, serverId: payload.serverId, action: 'terminal.api_open', status: 'success', details: `${detail} as ${account}`, ip: clientIP });
    ws.send('\r\n\x1b[32m' + (isHost ? 'Connected as ' + account : 'Connected to ' + detail) + '\x1b[0m\r\n\r\n');

    const touch = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => finish('idle timeout'), limits.idleMs);
    };
    touch();
    maxTimer = setTimeout(() => finish('maximum session time'), limits.maxSessionMs);

    stream.on('data', (d) => { touch(); if (ws.readyState === WebSocket.OPEN) ws.send(d.toString('utf-8')); });
    // For a command the ssh channel IS the exec: when it ends the whole session is torn down,
    // so there is never a host shell left behind it.
    stream.on('close', () => finish('shell ended'));
    ws.on('message', (data) => {
      touch();
      const msg = data.toString();
      try {
        const p = JSON.parse(msg);
        if (p && p.type === 'resize') { stream.setWindow(Number(p.rows) || 24, Number(p.cols) || 80); return; }
        if (p && p.type === 'auth') return; // never typed into the shell
      } catch { /* raw input */ }
      stream.write(msg);
    });
  } catch (err) {
    console.error('[WS] api-terminal error:', err && err.message);
    refuse(ws, 4002, 'Could not open the terminal: ' + String((err && err.message) || err).slice(0, 100));
    finish('failed to open');
  }

  function fail(message, code) {
    refuse(ws, code, message);
    audit({ userId: payload.userId, serverId: payload.serverId, action: 'terminal.api_open', status: 'failure', details: `${detail}: ${message}`.slice(0, 500), ip: clientIP });
    finish('refused');
  }
}

module.exports = { handleApiTerminal };
