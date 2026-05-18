import { createServer } from 'http';
import { parse } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import { jwtVerify, SignJWT } from 'jose';
import { Client } from 'ssh2';
import crypto from 'crypto';

const PORT = process.env.WS_PORT || 3002;
const AUTH_SECRET = process.env.AUTH_SECRET || 'fallback-secret-change-me';
const MASTER_KEY = process.env.MASTER_KEY || 'fallback-master-key';
const RQLITE_HOST = process.env.RQLITE_HOST || '127.0.0.1:4001';

// Simple in-memory rate limiting
const rateLimitMap = new Map();
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60000;

// Health check endpoint
const server = createServer((req, res) => {
  const parsedUrl = parse(req.url || '', true);
  if (parsedUrl.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'ws-server' }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bosun WebSocket Server');
});

const wss = new WebSocketServer({ server });

// Encryption helpers (same logic as in src/lib/crypto/keys.ts)
function deriveKey(masterKey) {
  const salt = 'bosun-ssh-key-encryption';
  return crypto.pbkdf2Sync(masterKey, salt, 100000, 32, 'sha256');
}

function decrypt(encryptedBase64, masterKey) {
  const ALGORITHM = 'aes-256-gcm';
  const IV_LENGTH = 16;
  const TAG_LENGTH = 16;
  const key = deriveKey(masterKey);
  const combined = Buffer.from(encryptedBase64, 'base64');
  const iv = combined.subarray(0, IV_LENGTH);
  const authTag = combined.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const encrypted = combined.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(encrypted, undefined, 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// DB helpers for rqlite
async function queryRqlite(sql) {
  const res = await fetch(`http://${RQLITE_HOST}/db/query?pretty`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql: [sql] })
  });
  if (!res.ok) throw new Error('Rqlite query failed');
  const data = await res.json();
  return data.results?.[0]?.values || [];
}

// JWT helpers
const secret = new TextEncoder().encode(AUTH_SECRET);

async function verifyToken(token) {
  try {
    const { payload } = await jwtVerify(token, secret);
    return payload;
  } catch {
    return null;
  }
}

async function createWsToken(userId, username) {
  return new SignJWT({ userId, username, type: 'ws' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(secret);
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

// Active SSH sessions
const sshSessions = new Map();

async function connectToServer(serverId) {
  // Fetch server details from rqlite
  const serverRows = await queryRqlite(`SELECT hostname, ssh_port, ssh_user, ssh_key_id FROM servers WHERE id = '${serverId}'`);
  if (!serverRows.length) throw new Error('Server not found');
  const [hostname, sshPort, sshUser, sshKeyId] = serverRows[0];

  // Fetch SSH key
  const keyRows = await queryRqlite(`SELECT private_key_enc FROM ssh_keys WHERE id = '${sshKeyId}'`);
  if (!keyRows.length) throw new Error('SSH key not found');
  const privateKeyEnc = keyRows[0][0];

  // Decrypt the private key
  const privateKey = decrypt(privateKeyEnc, MASTER_KEY);

  const client = new Client();
  await new Promise((resolve, reject) => {
    client.on('ready', () => resolve());
    client.on('error', reject);
    client.connect({
      host: hostname,
      port: parseInt(sshPort) || 22,
      username: sshUser,
      privateKey,
      readyTimeout: 15000
    });
  });

  return client;
}

wss.on('connection', async (ws, req) => {
  const url = parse(req.url || '', true);
  const sessionId = url.query.sessionId;
  const serverId = url.query.serverId;
  const token = url.query.token;

  // Validate session ID
  if (!sessionId) {
    ws.close(4000, 'Missing sessionId');
    return;
  }

  // Rate limit check
  if (!checkRateLimit(sessionId)) {
    ws.close(4000, 'Rate limit exceeded');
    return;
  }

  // Verify token
  const payload = await verifyToken(token);
  if (!payload) {
    ws.close(4001, 'Invalid token');
    return;
  }

  // Validate server ID
  if (!serverId) {
    ws.close(4000, 'Missing serverId');
    return;
  }

  console.log(`[WS] Client connected: session=${sessionId}, server=${serverId}, user=${payload.username}`);

  let client = null;
  let stream = null;

  try {
    // Connect to SSH server
    const sshClient = await connectToServer(serverId);
    client = sshClient;

    // Open PTY shell
    stream = await new Promise((resolve, reject) => {
      sshClient.shell({ term: 'xterm-color' }, (err, s) => {
        if (err) reject(err);
        else resolve(s);
      });
    });

    // Store session
    const session = { client: sshClient, stream, ws, createdAt: Date.now() };
    sshSessions.set(sessionId, session);

    // Handle SSH -> WS (terminal output)
    stream.on('data', (data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data.toString('utf-8'));
      }
    });

    stream.on('close', () => {
      console.log(`[WS] SSH stream closed: session=${sessionId}`);
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    });

    stream.on('error', (err) => {
      console.error(`[WS] SSH stream error: session=${sessionId}, error=${err.message}`);
    });

    // Handle WS -> SSH (terminal input and control messages)
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());

        switch (msg.type) {
          case 'input':
            // Terminal input (keypresses)
            if (stream && !stream.destroyed) {
              stream.write(msg.data);
            }
            break;

          case 'resize':
            // Resize terminal
            if (stream && !stream.destroyed && msg.cols && msg.rows) {
              stream.setWindow(msg.rows, msg.cols, 0, 0);
            }
            break;

          case 'ping':
            // Keepalive response
            break;

          default:
            console.warn(`[WS] Unknown message type: ${msg.type}`);
        }
      } catch {
        // Non-JSON message - treat as terminal input (backward compatibility)
        if (stream && !stream.destroyed) {
          stream.write(data.toString());
        }
      }
    });

    ws.on('close', () => {
      console.log(`[WS] Client disconnected: session=${sessionId}`);
      if (stream && !stream.destroyed) {
        stream.end();
      }
      if (client) {
        client.end();
      }
      sshSessions.delete(sessionId);
    });

    ws.on('error', (err) => {
      console.error(`[WS] Client error: session=${sessionId}, error=${err.message}`);
    });

  } catch (err) {
    console.error(`[WS] Connection error: session=${sessionId}, error=${err.message}`);
    ws.close(4002, err.message);
    if (client) client.end();
  }
});

// Periodic cleanup of stale sessions
setInterval(() => {
  const now = Date.now();
  const MAX_SESSION_AGE = 3600000; // 1 hour
  for (const [sessionId, session] of sshSessions) {
    if (now - session.createdAt > MAX_SESSION_AGE) {
      console.log(`[WS] Cleaning stale session: ${sessionId}`);
      session.stream?.end();
      session.client?.end();
      sshSessions.delete(sessionId);
    }
  }
}, 300000);

server.listen(PORT, () => {
  console.log(`[WS] Bosun WebSocket server running on port ${PORT}`);
});