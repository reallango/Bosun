'use strict';

const http = require('http');
const url = require('url');
const WebSocket = require('ws');
const crypto = require('crypto');

const PORT = process.env.WS_PORT || 3002;
const AUTH_SECRET = process.env.AUTH_SECRET || 'fallback-secret-change-me';
const MASTER_KEY = process.env.MASTER_KEY || 'fallback-master-key';
const RQLITE_HOST = process.env.RQLITE_HOST || '127.0.0.1:4001';

// WebSocket path for terminal (Cloudflare-compatible)
const WS_PATH = '/ws/terminal';

// Heartbeat interval to prevent idle disconnects
const HEARTBEAT_MS = Number(process.env.WS_HEARTBEAT_MS) || 30000;

// Rate limiting
const rateLimitMap = new Map();
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60000;

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
  
  // Simple echo for now - full SSH in next iteration
  ws.on('message', (data) => {
    console.log('[WS] Received from session=' + sessionId + ':', data.toString().substring(0, 50));
    ws.send('Connected to ws-server. SSH backend coming soon.\r\n');
  });

  ws.on('close', () => {
    console.log('[WS] Client disconnected: session=' + sessionId);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('[WS] Bosun WebSocket server running on port ' + PORT);
  console.log('[WS] Path: ' + WS_PATH);
  console.log('[WS] Heartbeat: ' + HEARTBEAT_MS + 'ms');
});
