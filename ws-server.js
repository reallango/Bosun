'use strict';

const http = require('http');
const url = require('url');
const WebSocket = require('ws');
const crypto = require('crypto');
const sshHelpers = require('./src/lib/collect/ssh');
const { clientIpFromHeaders } = require('./src/lib/net/client-ip');

const PORT = process.env.WS_PORT || 3002;
const { getAuthSecret, rqliteAuthHeaders } = require('./src/lib/secrets');
// Signing secret: env AUTH_SECRET, else the data-volume secrets file (re-read
// when it changes, e.g. after this node joins a cluster).
if (!getAuthSecret()) {
  console.error('[WS] no AUTH_SECRET (env or secrets file); refusing to start.');
  process.exit(1);
}
const RQLITE_HOST = process.env.RQLITE_HOST || '127.0.0.1:4001';

// WebSocket path for terminal (Cloudflare-compatible)
const WS_PATH = '/ws/terminal';
// API terminals (API keys only; non-admin shell account or one package command). A separate
// route, token type and handler: see src/lib/terminal/api-terminal-session.js.
const API_WS_PATH = '/ws/api-terminal';
const { handleApiTerminal } = require('./src/lib/terminal/api-terminal-session');

// SSH sessions map
const sshSessions = new Map();

// Heartbeat interval to prevent idle disconnects
const HEARTBEAT_MS = Number(process.env.WS_HEARTBEAT_MS) || 30000;

// How long an SSH session is kept with no browser attached, so a reload or a
// dropped connection can reattach to it.
const DETACHED_TTL_MS = Number(process.env.WS_DETACHED_TTL_MS) || 15 * 60 * 1000;

/** End a session's SSH connection and forget it. */
function destroySession(sessionId) {
  const session = sshSessions.get(sessionId);
  if (!session) return;
  sshSessions.delete(sessionId);
  if (session.detachTimer) clearTimeout(session.detachTimer);
  session.detachTimer = null;
  try { if (session.stream) session.stream.close(); } catch {}
  try { if (session.client) session.client.end(); } catch {}
  try { if (session.ws && session.ws.readyState === WebSocket.OPEN) session.ws.close(); } catch {}
}

/** Attach a browser to a session (cancels its detached timer). */
function attachSocket(sessionId, session, ws) {
  if (session.detachTimer) clearTimeout(session.detachTimer);
  session.detachTimer = null;
  // A previous browser still attached to this session is replaced.
  if (session.ws && session.ws !== ws && session.ws.readyState === WebSocket.OPEN) {
    try { session.ws.close(4004, 'Session opened elsewhere'); } catch {}
  }
  session.ws = ws;
  session.lastActivity = Date.now();
  ws.on('close', () => {
    // Only the socket currently attached may detach the session (an older one closing late must not).
    if (sshSessions.get(sessionId) !== session || session.ws !== ws) return;
    console.log('[WS] Client disconnected: session=' + sessionId + ' (keeping SSH for ' + Math.round(DETACHED_TTL_MS / 1000) + 's)');
    session.ws = null;
    session.detachTimer = setTimeout(() => {
      console.log('[WS] Detached session expired: ' + sessionId);
      destroySession(sessionId);
    }, DETACHED_TTL_MS);
  });
  ws.on('error', (err) => console.error('[WS] Error on session: ' + sessionId, err.message));
}

/** Send terminal output to whichever browser is attached now. */
function sendToSession(session, data) {
  if (session.ws && session.ws.readyState === WebSocket.OPEN) {
    try { session.ws.send(data); } catch {}
  }
}

// Rate limiting
const rateLimitMap = new Map();
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60000;

// A package's terminal action opens a terminal that runs one command of the package. The command travels in a signed,
// single-use token (minted by the widget-actions route after its permission, role and check passed); this server only
// runs what the token says.
const apiTerm = require('./src/lib/terminal/api-terminal');
const usedCmdTokens = new apiTerm.UsedTokens();

// Query rqlite database (parameterized)
async function queryRqlite(sql, params = []) {
  try {
    const res = await fetch(`http://${RQLITE_HOST}/db/query`, {
      method: 'POST',
      headers: { ...rqliteAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify([[sql, ...params]]),
    });
    const json = await res.json();
    const result = json.results?.[0];
    if (result?.error) throw new Error(result.error);
    return result?.values || [];
  } catch (err) {
    console.error('[WS] Rqlite query error:', err.message);
    throw err;
  }
}

// Append an audit record (best effort; never throws).
async function auditLog(entry) {
  try {
    await fetch(`http://${RQLITE_HOST}/db/execute`, {
      method: 'POST',
      headers: { ...rqliteAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify([[
        'INSERT INTO audit_log (id, user_id, server_id, action, category, details, status, ip_address, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        crypto.randomUUID(), entry.userId || null, entry.serverId || null, entry.action, String(entry.action).split('.')[0],
        entry.details ? String(entry.details).slice(0, 500) : null, entry.status, entry.ip ? String(entry.ip).slice(0, 64) : null, entry.durationMs ?? null,
      ]]),
    });
  } catch (err) {
    console.error('[WS] audit write failed:', err.message);
  }
}

// Connect to server via SSH.
//
// The terminal connects directly with the account and password the user
// provides, rather than the stored service-account key. Widgets, the poller,
// health checks and OS detection keep using the service account via the
// connection pool; only the interactive terminal uses the user's own account.
// The password is supplied per-connection and never stored.
//
// The host key is checked before the password is sent: the server's pinned
// fingerprint must match (pinned on first use, as for the service account).
async function connectToServer(serverId, sshUser, sshPassword) {
  // Get server details from rqlite (hostname/port/platform/pinned host key)
  const servers = await queryRqlite('SELECT id, hostname, ssh_port, platform, host_key_fingerprint FROM servers WHERE id = ?', [serverId]);
  if (!servers || servers.length === 0) {
    throw new Error('Server not found');
  }

  const server = servers[0];
  const serverHostname = server[1];
  const sshPort = server[2] || 22;
  const platform = server[3] || 'linux';
  const pinned = server[4] || undefined;

  const client = await sshHelpers.connect({
    host: serverHostname,
    port: sshPort,
    username: sshUser,
    password: sshPassword,
    readyTimeout: 10000,
    keepaliveInterval: 30000,
    expectedFingerprint: pinned,
    onNewFingerprint: (fp) => {
      rqliteExecute('UPDATE servers SET host_key_fingerprint = ? WHERE id = ? AND host_key_fingerprint IS NULL', [fp, serverId]);
    },
  });
  client.on('error', (err) => console.error('[WS] SSH error:', err.message));
  console.log('[WS] SSH connected to', serverHostname, 'as', sshUser);
  return { client, platform };
}

// Run one write statement (best effort; never throws).
async function rqliteExecute(sql, params = []) {
  try {
    await fetch(`http://${RQLITE_HOST}/db/execute`, {
      method: 'POST',
      headers: { ...rqliteAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify([[sql, ...params]]),
    });
  } catch (err) {
    console.error('[WS] rqlite write failed:', err.message);
  }
}

// Health check
const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  if (parsedUrl.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'ws-server' }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bosun WebSocket Server');
});

const wss = new WebSocket.Server({ noServer: true });

// Heartbeat to prevent idle disconnects
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
});

const heartbeat = setInterval(() => {
  wss.clients.forEach((client) => {
    if (client.isAlive === false) {
      console.log('[WS] Terminating stale connection');
      return client.terminate();
    }
    client.isAlive = false;
    try { client.ping(); } catch {}
  });
}, HEARTBEAT_MS);

wss.on('close', () => {
  clearInterval(heartbeat);
});

// Handle WebSocket upgrade with path validation
server.on('upgrade', (req, socket, head) => {
  const parsedUrl = new URL(req.url, 'http://localhost');
  const pathname = parsedUrl.pathname;

  // Validate path
  if (pathname !== WS_PATH && pathname !== API_WS_PATH) {
    console.log('[WS] Invalid path:', pathname);
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\nInvalid WS path');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

// JWT verification: HS256 signature, expiry and token type. Only the
// short-lived `type: 'ws'` tokens minted by /api/ws-token are accepted.
function verifyToken(token, expectedType = 'ws') {
  try {
    const parts = String(token).split('.');
    if (parts.length !== 3) return null;
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    if (header.alg !== 'HS256') return null;
    const expected = crypto.createHmac('sha256', getAuthSecret()).update(parts[0] + '.' + parts[1]).digest();
    const actual = Buffer.from(parts[2], 'base64url');
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== 'number' || payload.exp < now) return null;
    if (payload.type !== expectedType || !payload.userId) return null;
    return payload;
  } catch {
    return null;
  }
}

// Rate limiter
function checkRateLimit(sessionId) {
  const now = Date.now();
  const record = rateLimitMap.get(sessionId);
  if (!record || now > record.resetTime) {
    rateLimitMap.set(sessionId, { count: 1, resetTime: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (record.count >= RATE_LIMIT_MAX) return false;
  record.count++;
  return true;
}

wss.on('connection', async (ws, req) => {
  const parsedUrl = url.parse(req.url, true);
  const sessionId = parsedUrl.query.sessionId;
  const serverId = parsedUrl.query.serverId;
  const token = parsedUrl.query.token;
  // Terminal login uses the user's own account. The username travels in the
  // URL; the password arrives as the first WebSocket frame so it is never
  // written to URLs or access logs.
  const sshUser = (parsedUrl.query.sshUser || '').toString().trim();
  // Optional: run a package's command (cmdToken, signed) instead of a login shell; cmdLabel only names it for the person.
  const cmdToken = (parsedUrl.query.cmdToken || '').toString();
  const cmdLabel = (parsedUrl.query.cmdLabel || '').toString().trim();

  // Client IP: nginx's X-Bosun-Peer, and X-Forwarded-For only from a trusted proxy (src/lib/net/client-ip.js).
  // The header is only believed from nginx on this machine.
  const socketAddr = req.socket.remoteAddress || '';
  const viaLocalNginx = /^(127\.|::1$|::ffff:127\.)/.test(socketAddr);
  const clientIP = viaLocalNginx
    ? clientIpFromHeaders((name) => req.headers[name], socketAddr)
    : clientIpFromHeaders(() => undefined, socketAddr);

  // API terminals have their own handler and token type; nothing below is shared with them.
  if (parsedUrl.pathname === API_WS_PATH) {
    return handleApiTerminal(ws, parsedUrl, { verifyToken, queryRqlite, audit: auditLog, clientIP });
  }

  // Validate token first (most common failure - log without exposing token)
  if (!token) {
    console.log('[WS] Missing token, ip=' + clientIP);
    ws.close(4001, 'Missing token');
    return;
  }

  const payload = verifyToken(token);
  if (!payload) {
    console.log('[WS] Invalid token, ip=' + clientIP);
    ws.close(4001, 'Invalid token');
    return;
  }

  // Host shells and package terminals both need Full access (admin), and only
  // for a signed-in user (tokens are never minted for API keys; refuse any
  // that claim to be one).
  const isApiKey = payload.authType === 'api_key' || String(payload.userId).startsWith('apikey:');
  if (payload.role !== 'admin' || isApiKey) {
    ws.close(4003, 'Insufficient permissions');
    return;
  }

  if (!sessionId) {
    ws.close(4000, 'Missing sessionId');
    return;
  }

  if (cmdLabel.length > 200) {
    ws.close(4000, 'Invalid terminal');
    return;
  }

  if (!checkRateLimit(sessionId)) {
    console.log('[WS] Rate limit exceeded, session=' + sessionId);
    ws.close(4000, 'Rate limit exceeded');
    return;
  }

  if (!serverId) {
    ws.close(4000, 'Missing serverId');
    return;
  }

  if (!sshUser) {
    ws.close(4000, 'Missing credentials');
    return;
  }

  console.log('[WS] Client connected: session=' + sessionId + ', server=' + serverId + ', ip=' + clientIP);
  
  // ========== CHECK FOR EXISTING SESSION (REATTACH) ==========
  const existingSession = sshSessions.get(sessionId);
  // Another user's session is never reattached or torn down from here.
  if (existingSession && existingSession.ownerUserId !== payload.userId) {
    ws.close(4003, 'Session belongs to someone else');
    return;
  }
  // A session can only be reattached for the same server/terminal and SSH
  // account; anything else starts a fresh session.
  const sameTarget = existingSession &&
    existingSession.serverId === serverId &&
    (existingSession.cmdLabel || '') === cmdLabel &&
    existingSession.username === sshUser;
  if (existingSession && existingSession.stream && sameTarget) {
    console.log('[WS] Reattaching to existing session: ' + sessionId);
    attachSocket(sessionId, existingSession, ws);

    ws.send('\r\n\x1b[33m[Session restored]\x1b[0m\r\n');
    // Replay buffer so user sees previous output
    for (const chunk of existingSession.buffer) ws.send(chunk);

    ws.on('message', (msg) => {
      if (existingSession.ws !== ws) return;
      try {
        const parsed = JSON.parse(msg.toString());
        // A reconnect may still send the auth frame; the session is already
        // authenticated, so drop it rather than typing it into the shell.
        if (parsed.type === 'auth') return;
        if (parsed.type === 'resize') {
          existingSession.stream.setWindow(parsed.rows, parsed.cols);
          return;
        }
      } catch {}
      existingSession.stream.write(msg.toString());
      existingSession.lastActivity = Date.now();
    });
    return; // SKIP creating new SSH connection
  }

  // The same user's session for another target (or one still connecting) is replaced.
  if (existingSession) {
    console.log('[WS] Replacing session for a different target: ' + sessionId);
    destroySession(sessionId);
  }

  // A package terminal needs its signed command token (a reattach above needs none: the session already exists).
  let command = null;
  if (cmdLabel) {
    const cmdPayload = cmdToken ? verifyToken(cmdToken, apiTerm.WEB_CMD_TOKEN_TYPE) : null;
    const okClaims = cmdPayload && apiTerm.checkWebCommandClaims(cmdPayload, payload).ok && cmdPayload.serverId === serverId && cmdPayload.label === cmdLabel;
    if (!okClaims) { ws.close(4003, 'Invalid or expired terminal token'); return; }
    if (!usedCmdTokens.consume(cmdPayload.jti, cmdPayload.exp)) { ws.close(4001, 'Token already used'); return; }
    command = cmdPayload.cmd;
  }

  // ========== NEW SESSION ==========
  let ptyReady = false;
  let passwordResolver = null;
  const earlyMessages = [];
  // The session record exists from the start, so a browser that leaves while
  // the SSH login is still in progress is noticed and the login is abandoned.
  const session = {
    client: null,
    stream: null,
    ws: null,
    buffer: [],
    createdAt: Date.now(),
    lastActivity: Date.now(),
    detachTimer: null,
    username: sshUser,
    serverId: serverId,
    cmdLabel: cmdLabel,
    ownerUserId: payload.userId,
  };
  sshSessions.set(sessionId, session);
  attachSocket(sessionId, session, ws);
  const abandoned = () => sshSessions.get(sessionId) !== session || session.ws === null;

  // Single input handler for the new session. Until the PTY is ready we buffer
  // browser input (and resolve the password frame); afterwards it goes straight
  // to the SSH stream. The password never travels in the URL.
  ws.on('message', (data) => {
    if (session.ws !== ws) return;
    const msg = data.toString();
    let parsed = null;
    try { parsed = JSON.parse(msg); } catch {}

    if (parsed && parsed.type === 'auth') {
      if (typeof parsed.password === 'string' && passwordResolver) {
        passwordResolver(parsed.password);
      }
      return;
    }

    if (ptyReady && session.stream) {
      if (parsed && parsed.type === 'resize') {
        session.stream.setWindow(parsed.rows, parsed.cols);
      } else {
        session.stream.write(msg);
        session.lastActivity = Date.now();
      }
      return;
    }

    if (earlyMessages.length < 200) earlyMessages.push(msg);
  });

  // Resolves once the client's password frame has been received.
  const waitForPassword = () => new Promise((resolve) => {
    passwordResolver = (password) => {
      passwordResolver = null;
      resolve(password);
    };
  });

  try {
    const sshPassword = await Promise.race([
      waitForPassword(),
      new Promise((resolve) => setTimeout(() => resolve(''), 15000)),
    ]);
    if (abandoned()) { destroySession(sessionId); return; }
    if (!sshPassword) {
      ws.send('\r\n*** SSH connection failed: credentials not provided ***\r\n');
      ws.close(4002, 'credentials not provided');
      destroySession(sessionId);
      return;
    }

    // Connect to server via SSH as the user's own account
    const connected = await connectToServer(serverId, sshUser, sshPassword);
    session.client = connected.client;
    // The browser left (or the session was replaced) while logging in: don't keep a shell nobody asked for.
    if (abandoned()) {
      try { connected.client.end(); } catch {}
      if (sshSessions.get(sessionId) === session) sshSessions.delete(sessionId);
      return;
    }
    connected.client.on('close', () => {
      if (sshSessions.get(sessionId) === session) destroySession(sessionId);
    });

    // Open a PTY. Windows hosts get an interactive PowerShell session; Linux
    // hosts get their login shell. Everything downstream (stream, reattach,
    // buffer, resize) is transport-agnostic once a stream exists.
    const openPty = (err, stream) => {
      if (err) {
        sendToSession(session, '\r\n*** SSH shell failed: ' + err.message + ' ***\r\n');
        if (session.ws) session.ws.close(4002, err.message);
        destroySession(sessionId);
        return;
      }
      if (sshSessions.get(sessionId) !== session) { try { stream.close(); } catch {} return; }

      session.stream = stream;
      // Windows sessions have no MOTD/"Last login" preamble, so only Linux
      // needs the post-login screen clear.
      let loginBannerCleared = connected.platform === 'windows';
      sendToSession(session, connected.platform === 'windows'
        ? '\r\n\x1b[32mConnected to server via PowerShell\x1b[0m\r\n\r\n'
        : '\r\n\x1b[32mConnected to server via SSH\x1b[0m\r\n\r\n');

      // Flush input buffered while the session was starting, then route all
      // further input straight to the stream.
      ptyReady = true;
      for (const msg of earlyMessages.splice(0)) {
        try {
          const json = JSON.parse(msg);
          if (json.type === 'resize') {
            stream.setWindow(json.rows, json.cols);
            continue;
          }
        } catch {}
        stream.write(msg);
      }

      // SSH output -> whichever browser is attached now (after a reattach, the new one) + buffer
      stream.on('data', (data) => {
        const str = data.toString('utf-8');

        // Linux login shells print the MOTD and a "Last login: ..." line before
        // the prompt. Once the shell starts producing output, ask it to clear
        // the screen (Ctrl+L) so the terminal opens on a clean prompt instead of
        // that banner. Windows has no equivalent preamble.
        if (!loginBannerCleared) {
          loginBannerCleared = true;
          setTimeout(() => {
            try { stream.write('\x0c'); } catch {}
          }, 300);
        }

        // Buffer output (keep last 1000 chunks)
        session.buffer.push(str);
        if (session.buffer.length > 1000) session.buffer.shift();
        session.lastActivity = Date.now();
        sendToSession(session, str);
      });

      stream.on('close', () => {
        console.log('[WS] SSH stream closed for session: ' + sessionId);
        if (sshSessions.get(sessionId) === session) destroySession(sessionId);
      });
    };

    if (command) {
      // A package's terminal: its one command through the host's SSH session (the person's own login).
      sendToSession(session, '\r\n\x1b[36mOpening ' + cmdLabel + '...\x1b[0m\r\n');
      connected.client.exec(command, { pty: { term: 'xterm-256color', cols: 80, rows: 24 } }, openPty);
    } else if (connected.platform === 'windows') {
      // exec() gives a stream we can drive directly; with a pty, powershell.exe
      // renders an interactive prompt (client.shell() would run cmd.exe).
      connected.client.exec('powershell -NoLogo -NoProfile', { pty: { term: 'xterm-256color', cols: 80, rows: 24 } }, openPty);
    } else {
      connected.client.shell({ term: 'xterm-256color', cols: 80, rows: 24 }, openPty);
    }
  } catch (err) {
    console.error('[WS] SSH connection error:', err.message);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send('\r\n*** SSH connection failed: ' + err.message + ' ***\r\n');
      ws.close(4002, String(err.message).slice(0, 120));
    }
    if (sshSessions.get(sessionId) === session) destroySession(sessionId);
  }
});

// Loopback only by default: browsers reach this through nginx on port 3042.
server.listen(PORT, process.env.BOSUN_INTERNAL_HOST || '127.0.0.1', () => {
  console.log('[WS] Bosun WebSocket server running on port ' + PORT);
  console.log('[WS] Path: ' + WS_PATH);
  console.log('[WS] Heartbeat: ' + HEARTBEAT_MS + 'ms');
});
