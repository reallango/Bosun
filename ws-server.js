import { createServer } from 'http';
import { parse } from 'url';
import { WebSocketServer, WebSocket } from 'ws';

const server = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bosun WebSocket Server');
});

const wss = new WebSocketServer({ server });

// Store active connections by session
const sessions = new Map<string, Set<WebSocket>>();

wss.on('connection', (ws, req) => {
  const url = parse(req.url || '', true);
  const sessionId = url.query.sessionId as string;

  if (!sessionId) {
    ws.close();
    return;
  }

  // Add to session
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, new Set());
  }
  sessions.get(sessionId)!.add(ws);

  console.log(`[WS] Client connected to session ${sessionId}`);

  ws.on('message', (data) => {
    // Broadcast to all in same session
    const clients = sessions.get(sessionId);
    if (clients) {
      clients.forEach(client => {
        if (client !== ws && client.readyState === WebSocket.OPEN) {
          client.send(data.toString());
        }
      });
    }
  });

  ws.on('close', () => {
    const clients = sessions.get(sessionId);
    if (clients) {
      clients.delete(ws);
      if (clients.size === 0) {
        sessions.delete(sessionId);
      }
    }
    console.log(`[WS] Client disconnected from session ${sessionId}`);
  });
});

const PORT = process.env.WS_PORT || 3002;
server.listen(PORT, () => {
  console.log(`[WS] Bosun WebSocket server running on port ${PORT}`);
});