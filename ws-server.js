'use strict';

const http = require('http');
const url = require('url');
const WebSocket = require('ws');
const crypto = require('crypto');
const { Client } = require('ssh2');

const PORT = process.env.WS_PORT || 3002;
const AUTH_SECRET = process.env.AUTH_SECRET || 'fallback-secret-change-me';
const MASTER_KEY = process.env.MASTER_KEY || 'fallback-master-key';
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

// Decrypt private key using MASTER_KEY
function decrypt(encryptedData) {
  try {
    const ALGORITHM = 'aes-256-gcm';
    const IV_LENGTH = 16;
    const TAG_LENGTH = 16;

    const key = crypto.pbkdf2Sync(
      MASTER_KEY,
      'bosun-ssh-key-encryption',
      100000,
      32,
      'sha256'
    );

    const combined = Buffer.from(encryptedData, 'base64');
    const iv = combined.subarray(0, IV_LENGTH);
    const authTag = combined.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const encrypted = combined.subarray(IV_LENGTH + TAG_LENGTH);

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encrypted, undefined, 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  } catch (err) {
    console.error('[WS] Decrypt error:', err.message);
    throw err;
  }
}

// Connect to server via SSH
async function connectToServer(serverId) {
  const conn = new Client();
  
  // Get server details from rqlite
  const servers = await queryRqlite(`SELECT id, hostname, ssh_port, ssh_user, ssh_key_id FROM servers WHERE id = '${serverId}'`);
  if (!servers || servers.length === 0) {
    throw new Error('Server not found');
  }
  
  const server = servers[0];
  const serverHostname = server[1];
  const sshPort = server[2] || 22;
  const sshUser = server[3];
  const sshKeyId = server[4];
  
  if (!sshKeyId) {
    throw new Error('No SSH key configured for this server');
  }
  
  // Get private key
  const keys = await queryRqlite(`SELECT private_key_enc FROM ssh_keys WHERE id = '${sshKeyId}'`);
  if (!keys || keys.length === 0) {
    throw new Error('SSH key not found');
  }
  
  const privateKey = decrypt(keys[0][0]);
  
  return new Promise((resolve, reject) => {
    conn.connect({
      host: serverHostname,
      port: sshPort,
      username: sshUser,
      privateKey: privateKey,
      readyTimeout: 10000,
    });
    
    conn.on('ready', () => {
      console.log('[WS] SSH connected to', serverHostname);
      resolve(conn);
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

  console.log('[WS] Client connected: session=' + sessionId + ', server=' + serverId + ', ip=' + clientIP);
  
  // ========== CHECK FOR EXISTING SESSION (REATTACH) ==========
  const existingSession = sshSessions.get(sessionId);
  if (existingSession && existingSession.stream && existingSession.authenticated) {
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

  // ========== NEW SESSION ==========
  let sshClient = null;
  let sshStream = null;
  const outputBuffer = [];
  
  try {
    // Connect to server via SSH
    sshClient = await connectToServer(serverId);
    
    // Open PTY shell
    sshClient.shell({ term: 'xterm-256color', cols: 80, rows: 24 }, (err, stream) => {
      if (err) {
        ws.send('\r\n*** SSH shell failed: ' + err.message + ' ***\r\n');
        ws.close(4002, err.message);
        return;
      }
      
      sshStream = stream;
      ws.send('\r\n\x1b[32mConnected to server via SSH\x1b[0m\r\n\r\n');
      
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
      
      // Browser input -> SSH
      ws.on('message', (data) => {
        const msg = data.toString();
        
        // Handle resize JSON
        try {
          const json = JSON.parse(msg);
          if (json.type === 'resize' && sshStream) {
            sshStream.setWindow(json.rows, json.cols);
            return;
          }
        } catch {
          // Not JSON, write raw
        }
        
        // Write raw input to SSH
        if (sshStream) {
          sshStream.write(msg);
        }
      });
    });
    
    // Store expanded session data
    const sessionData = {
      client: sshClient,
      stream: sshStream,
      ws: ws,
      buffer: outputBuffer,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      idleTimeout: null,
      username: '',
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
