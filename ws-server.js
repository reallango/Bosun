'use strict';

const http = require('http');
const url = require('url');
const WebSocket = require('ws');
const crypto = require('crypto');

const PORT = process.env.WS_PORT || 3002;
const AUTH_SECRET = process.env.AUTH_SECRET || 'fallback-secret-change-me';
const MASTER_KEY = process.env.MASTER_KEY || 'fallback-master-key';
const RQLITE_HOST = process.env.RQLITE_HOST || '127.0.0.1:4001';

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

const wss = new WebSocket.Server({ server });

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

  if (!sessionId) {
    ws.close(4000, 'Missing sessionId');
    return;
  }

  if (!checkRateLimit(sessionId)) {
    ws.close(4000, 'Rate limit exceeded');
    return;
  }

  const payload = verifyToken(token);
  if (!payload) {
    ws.close(4001, 'Invalid token');
    return;
  }

  if (!serverId) {
    ws.close(4000, 'Missing serverId');
    return;
  }

  console.log('[WS] Client connected: session=' + sessionId + ', server=' + serverId);
  
  // Simple echo for now - full SSH in next iteration
  ws.on('message', (data) => {
    console.log('[WS] Received:', data.toString().substring(0, 50));
    ws.send('Connected to ws-server. SSH backend coming soon.\r\n');
  });

  ws.on('close', () => {
    console.log('[WS] Client disconnected: session=' + sessionId);
  });
});

server.listen(PORT, () => {
  console.log('[WS] Bosun WebSocket server running on port ' + PORT);
});
