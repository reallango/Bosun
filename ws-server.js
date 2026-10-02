'use strict';

const http = require('http');
const url = require('url');
const WebSocket = require('ws');
const { Client } = require('ssh2');

const PORT = process.env.WS_PORT || 3002;
const AUTH_SECRET = process.env.AUTH_SECRET || 'fallback-secret-change-me';
const RQLITE_HOST = process.env.RQLITE_HOST || '127.0.0.1:4001';

// WebSocket path for terminal (Cloudflare-compatible)
const WS_PATH = '/ws/terminal';

// SSH sessions map
const sshSessions = new Map();

// Heartbeat interval to prevent idle disconnects
const HEARTBEAT_MS = Number(process.env.WS_HEARTBEAT_MS) || 30000;

// Grace period for reattach (Gap 5)
const GRACE_PERIOD_MS = Number(process.env.WS_GRACE_PERIOD_MS) || 30000;

// Rate limiting
const rateLimitMap = new Map();
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60000;

// Query rqlite database
async function queryRqlite(sql) {
  try {
    const res = await fetch(`http://${RQLITE_HOST}/db/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([sql]),
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

// Connect to server via SSH.
//
// The terminal connects directly with the account and password the user
// provides, rather than the stored service-account key. Widgets, the poller,
// health checks and OS detection keep using the service account via the
// connection pool; only the interactive terminal uses the user's own account.
// The password is supplied per-connection and never stored.
async function connectToServer(serverId, sshUser, sshPassword) {
  const conn = new Client();
  
  // Get server details from rqlite (hostname/port/platform only)
  const servers = await queryRqlite(`SELECT id, hostname, ssh_port, platform FROM servers WHERE id = '${serverId}'`);
  if (!servers || servers.length === 0) {
    throw new Error('Server not found');
  }
  
  const server = servers[0];
  const serverHostname = server[1];
  const sshPort = server[2] || 22;
  const platform = server[3] || 'linux';
  
  return new Promise((resolve, reject) => {
    conn.connect({
      host: serverHostname,
      port: sshPort,
      username: sshUser,
      password: sshPassword,
      readyTimeout: 10000,
    });
    
    conn.on('ready', () => {
      console.log('[WS] SSH connected to', serverHostname, 'as', sshUser);
      resolve({ client: conn, platform });
    });
    
    conn.on('error', (err) => {
      console.error('[WS] SSH error:', err.message);
      reject(err);
    });
  });
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
  if (pathname !== WS_PATH) {
    console.log('[WS] Invalid path:', pathname);
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\nInvalid WS path');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

// JWT verification - simple HS256
function verifyToken(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
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
  
  // Get client IP (respect x-forwarded-for for Cloudflare)
  const clientIP = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;

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

  if (!sessionId) {
    ws.close(4000, 'Missing sessionId');
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
  if (existingSession && existingSession.stream && existingSession.authenticated &&
      existingSession.username === sshUser) {
    console.log('[WS] Reattaching to existing session: ' + sessionId);

    // Cancel grace period timer (Gap 5)
    if (existingSession.graceTimer) {
      clearTimeout(existingSession.graceTimer);
      existingSession.graceTimer = null;
      console.log('[WS-Server] Grace period cancelled on reattach:', sessionId);
    }

    // Attach new WebSocket
    existingSession.ws = ws;
    existingSession.lastActivity = Date.now();

    // Send session restored marker
    ws.send('\r\n\x1b[33m[Session restored]\x1b[0m\r\n');

    // Replay buffer so user sees previous output
    for (const chunk of existingSession.buffer) {
      ws.send(chunk);
    }

    // Set up input: WebSocket -> SSH stream
    ws.on('message', (msg) => {
      try {
        const parsed = JSON.parse(msg.toString());
        // A reconnect may still send the auth frame; the session is already
        // authenticated, so drop it rather than typing it into the shell.
        if (parsed.type === 'auth') return;
        if (parsed.type === 'resize' && existingSession.stream) {
          existingSession.stream.setWindow(parsed.rows, parsed.cols);
          return;
        }
      } catch {}
      // Raw input
      if (existingSession.stream) {
        existingSession.stream.write(msg.toString());
        existingSession.lastActivity = Date.now();
      }
    });

    // Handle WebSocket disconnect (DON'T kill SSH) - Gap 5: grace period
    ws.on('close', () => {
      console.log('[WS-Server] Client disconnected, starting grace period for session:', sessionId);
      const session = sshSessions.get(sessionId);
      if (session) {
        session.ws = null;
        // Start grace period timer
        session.graceTimer = setTimeout(() => {
          console.log('[WS-Server] Grace period expired, destroying SSH session:', sessionId);
          if (session.client) session.client.end();
          if (session.stream) session.stream.close();
          sshSessions.delete(sessionId);
        }, GRACE_PERIOD_MS); // 30 seconds
      }
    });

    ws.on('error', (err) => {
      console.error('[WS] Error on reattached session: ' + sessionId, err.message);
      const session = sshSessions.get(sessionId);
      if (session) session.ws = null;
    });

    return; // SKIP creating new SSH connection
  }

  // An existing session for a *different* account can't be reused; tear it down
  // so its SSH connection doesn't linger before the new one starts.
  if (existingSession && existingSession.username !== sshUser) {
    console.log('[WS] Discarding stale session for a different user: ' + sessionId);
    if (existingSession.graceTimer) clearTimeout(existingSession.graceTimer);
    if (existingSession.idleTimeout) clearTimeout(existingSession.idleTimeout);
    if (existingSession.client) existingSession.client.end();
    if (existingSession.stream) existingSession.stream.close();
    sshSessions.delete(sessionId);
  }

  // ========== NEW SESSION ==========
  let sshClient = null;
  let sshStream = null;
  let ptyReady = false;
  let passwordResolver = null;
  const outputBuffer = [];
  const earlyMessages = [];

  // Single input handler for the new session. Until the PTY is ready we buffer
  // browser input (and resolve the password frame); afterwards it goes straight
  // to the SSH stream. The password never travels in the URL.
  ws.on('message', (data) => {
    const msg = data.toString();
    let parsed = null;
    try { parsed = JSON.parse(msg); } catch {}

    if (parsed && parsed.type === 'auth') {
      if (typeof parsed.password === 'string' && passwordResolver) {
        passwordResolver(parsed.password);
      }
      return;
    }

    if (ptyReady && sshStream) {
      if (parsed && parsed.type === 'resize') {
        sshStream.setWindow(parsed.rows, parsed.cols);
      } else {
        sshStream.write(msg);
      }
      return;
    }

    earlyMessages.push(msg);
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
    if (!sshPassword) {
      ws.send('\r\n*** SSH connection failed: credentials not provided ***\r\n');
      ws.close(4002, 'credentials not provided');
      return;
    }

    // Connect to server via SSH as the user's own account
    const connected = await connectToServer(serverId, sshUser, sshPassword);
    sshClient = connected.client;

    // Open a PTY. Windows hosts get an interactive PowerShell session; Linux
    // hosts get their login shell. Everything downstream (stream, reattach,
    // buffer, resize) is transport-agnostic once a stream exists.
    const openPty = (err, stream) => {
      if (err) {
        ws.send('\r\n*** SSH shell failed: ' + err.message + ' ***\r\n');
        ws.close(4002, err.message);
        return;
      }

      sshStream = stream;
      ws.send(connected.platform === 'windows'
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

      // SSH output -> browser + buffer
      stream.on('data', (data) => {
        const str = data.toString('utf-8');

        // Buffer output (keep last 1000 chunks)
        outputBuffer.push(str);
        if (outputBuffer.length > 1000) {
          outputBuffer.shift();
        }

        // Update last activity
        const session = sshSessions.get(sessionId);
        if (session) session.lastActivity = Date.now();

        // Send to WebSocket if connected
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(str);
        }
      });

      stream.on('close', () => {
        console.log('[WS] SSH stream closed for session: ' + sessionId);
        const session = sshSessions.get(sessionId);
        if (session) {
          if (session.idleTimeout) clearTimeout(session.idleTimeout);
          if (session.ws && session.ws.readyState === WebSocket.OPEN) {
            session.ws.close();
          }
          if (session.client) session.client.end();
          sshSessions.delete(sessionId);
        }
      });
    };

    if (connected.platform === 'windows') {
      // exec() gives a stream we can drive directly; with a pty, powershell.exe
      // renders an interactive prompt (client.shell() would run cmd.exe).
      sshClient.exec('powershell -NoLogo -NoProfile', { pty: { term: 'xterm-256color', cols: 80, rows: 24 } }, openPty);
    } else {
      sshClient.shell({ term: 'xterm-256color', cols: 80, rows: 24 }, openPty);
    }

    // Store expanded session data
    const sessionData = {
      client: sshClient,
      stream: sshStream,
      ws: ws,
      buffer: outputBuffer,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      idleTimeout: null,
      username: sshUser,
      authenticated: true, // Shell created successfully - server-side auth complete
      serverId: serverId,
    };
    sshSessions.set(sessionId, sessionData);

    // Handle new session WebSocket disconnect
    ws.on('close', () => {
      console.log('[WS] Client disconnected: session=' + sessionId + ' (keeping SSH alive)');
      const session = sshSessions.get(sessionId);
      if (session) {
        session.ws = null;
        // Start idle timeout
        session.idleTimeout = setTimeout(() => {
          console.log('[WS] Idle timeout for session: ' + sessionId + ', cleaning up');
          if (session.client) session.client.end();
          if (session.stream) session.stream.close();
          sshSessions.delete(sessionId);
        }, 15 * 60 * 1000); // 15 minutes
      }
    });
    
    // WebSocket error for new session
    ws.on('error', (err) => {
      console.error('[WS] Error on session: ' + sessionId, err.message);
      const session = sshSessions.get(sessionId);
      if (session) {
        if (session.idleTimeout) clearTimeout(session.idleTimeout);
        if (session.client) session.client.end();
        sshSessions.delete(sessionId);
      }
    });

  } catch (err) {
    console.error('[WS] SSH connection error:', err.message);
    ws.send('\r\n*** SSH connection failed: ' + err.message + ' ***\r\n');
    ws.close(4002, err.message);
    sshSessions.delete(sessionId);
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('[WS] Bosun WebSocket server running on port ' + PORT);
  console.log('[WS] Path: ' + WS_PATH);
  console.log('[WS] Heartbeat: ' + HEARTBEAT_MS + 'ms');
});
