#!/usr/bin/env node
'use strict';

/**
 * Background Widget Poller Service
 * 
 * Polls widgets in the background and caches results.
 * Run as: node poller.js
 * 
 * Environment:
 *   RQLITE_HOST - rqlite address (default: 127.0.0.1:4001)
 *   POLL_INTERVAL_MS - base polling interval (default: 10000)
 *   MASTER_KEY - key for decrypting SSH private keys
 */

const http = require('http');
const crypto = require('crypto');
const { Client } = require('ssh2');
const { getLinuxWidgetData } = require('./src/lib/linux/collectors');
const { getWindowsWidgetData, powershellCommand } = require('./src/lib/windows/collectors');

const RQLITE_HOST = process.env.RQLITE_HOST || '127.0.0.1:4001';
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS) || 10000;
const MASTER_KEY = process.env.MASTER_KEY || 'fallback-master-key';

// Query rqlite
async function queryRqlite(sql, params = []) {
  try {
    const res = await fetch(`http://${RQLITE_HOST}/db/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params.length ? [sql, ...params] : [sql]),
    });
    const json = await res.json();
    return json.results?.[0]?.values || [];
  } catch (err) {
    console.error('[Poller] Query error:', err.message);
    return [];
  }
}

// Execute rqlite
async function executeRqlite(sql, params = []) {
  try {
    await fetch(`http://${RQLITE_HOST}/db/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params.length ? [sql, ...params] : [sql]),
    });
  } catch (err) {
    console.error('[Poller] Execute error:', err.message);
  }
}

// Check if this node is leader
async function isLeader() {
  try {
    const res = await fetch(`http://${RQLITE_HOST}/status`);
    const json = await res.json();
    // Check raft state for leadership
    const raftState = json.store?.raft?.state;
    if (raftState === 'Leader') return true;
    // Single node (no raft), assume leader
    if (!json.store?.raft) return true;
    return false;
  } catch (err) {
    console.error('[Poller] Leader check error:', err.message);
    return false;
  }
}

// Decrypt private key
function decrypt(encryptedData) {
  try {
    const ALGORITHM = 'aes-256-gcm';
    const IV_LENGTH = 16;
    const TAG_LENGTH = 16;
    const key = crypto.pbkdf2Sync(
      MASTER_KEY, 'bosun-ssh-key-encryption', 100000, 32, 'sha256'
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
    console.error('[Poller] Decrypt error:', err.message);
    throw err;
  }
}

// SSH connection cache
const sshConnections = new Map();

async function getSSHConnection(serverId) {
  if (sshConnections.has(serverId)) {
    return sshConnections.get(serverId);
  }
  
  const servers = await queryRqlite(
    `SELECT id, name, hostname, ssh_port, ssh_user, ssh_key_id, platform, os_type, os_version, is_online FROM servers WHERE id = ?`,
    [serverId]
  );
  if (!servers.length) {
    throw new Error('Server not found: ' + serverId);
  }
  
  const [sid, name, hostname, port, user, keyId, platform, osType, osVersion, isOnline] = servers[0];
  if (!keyId) {
    throw new Error('No SSH key for server');
  }
  
  const keys = await queryRqlite(
    `SELECT private_key_enc FROM ssh_keys WHERE id = ?`, [keyId]
  );
  if (!keys.length) {
    throw new Error('SSH key not found');
  }
  
  const privateKey = decrypt(keys[0][0]);
  
  const conn = new Promise((resolve, reject) => {
    const c = new Client();
    c.connect({
      host: hostname,
      port: port || 22,
      username: user,
      privateKey,
      readyTimeout: 10000,
    });
    c.on('ready', () => resolve(c));
    c.on('error', reject);
  });
  
  const server = {
    id: sid,
    name,
    hostname,
    os_type: osType,
    os_version: osVersion,
    is_online: isOnline,
  };

  const connection = { client: conn, platform: platform || 'linux', server };
  sshConnections.set(serverId, connection);
  return connection;
}

// Generate ID
function generateId() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// SHA-256 hash for change detection
function hashData(data) {
  return crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
}

// Main polling loop
async function pollWidgets() {
  lastPollAt = new Date().toISOString();
  const leader = await isLeader();
  if (!leader) {
    console.log('[Poller] Not leader, skipping cycle');
    return;
  }
  console.log('[Poller] I am leader, polling...');
  
  console.log('[Poller] Checking for widgets to poll...');
  
  try {
    // Get widgets that are pollable
    const widgets = await queryRqlite(`
      SELECT w.id, w.widget_type, w.server_id, w.config, wpc.poll_interval_sec, wpc.ttl_sec, wpc.storage_mode, wpc.last_polled_at, wpc.enabled
      FROM widgets w
      LEFT JOIN widget_polling_config wpc ON w.widget_type = wpc.widget_type AND w.server_id = wpc.server_id
      WHERE w.widget_type NOT IN ('ssh_terminal', 'server_summary')
      AND (wpc.enabled IS NULL OR wpc.enabled = 1)
      ORDER BY w.server_id, w.widget_type
    `);
    
    const now = Date.now();
    
    for (const row of widgets) {
      const [widgetId, widgetType, serverId, configJson, pollInterval, ttl, storageMode, lastPolled, enabled] = row;
      
      const intervalMs = (pollInterval || 30) * 1000;
      if (lastPolled && now - new Date(lastPolled).getTime() < intervalMs) {
        continue;
      }
      
      console.log(`[Poller] Polling ${widgetType} on ${serverId}...`);
      
      try {
        const { client, platform, server } = await getSSHConnection(serverId);

        // Run a command on the cached connection, returning the same
        // { stdout, stderr, exitCode } shape the shared collectors expect.
        const runCommand = (cmd) => new Promise((resolve, reject) => {
          client.exec(cmd, (err, stream) => {
            if (err) return reject(err);
            let stdout = '', stderr = '';
            stream.on('data', (d) => { stdout += d.toString(); });
            stream.stderr.on('data', (d) => { stderr += d.toString(); });
            stream.on('close', (code) => resolve({ stdout, stderr, exitCode: code || 0 }));
          });
        });

        // gpu_monitoring / ollama_status / custom_command are served live by the
        // widget route on both platforms, so the poller never handles them.
        let data;
        if (platform === 'windows') {
          data = await getWindowsWidgetData(widgetType, (s) => runCommand(powershellCommand(s)), { server });
        } else {
          data = await getLinuxWidgetData(widgetType, runCommand, { server });
        }

        if (data === undefined) {
          console.log(`[Poller] No collector for ${widgetType}`);
          continue;
        }

        // The cache column is TEXT; store the same JSON the route parses.
        data = JSON.stringify(data);
        const dataHash = hashData(data);
        const ttlSec = ttl || 300;
        
        // Check for changes in change_only mode
        if (storageMode === 'change_only') {
          const existing = await queryRqlite(
            `SELECT data_hash FROM widget_data_cache WHERE widget_type = ? AND server_id = ? ORDER BY collected_at DESC LIMIT 1`,
            [widgetType, serverId]
          );
          if (existing.length && existing[0][0] === dataHash) {
            console.log(`[Poller] No change for ${widgetType}, skipping cache update`);
            await executeRqlite(
              `UPDATE widget_polling_config SET last_polled_at = CURRENT_TIMESTAMP WHERE widget_type = ? AND server_id = ?`,
              [widgetType, serverId]
            );
            continue;
          }
        }
        
        // Store in cache
        const cacheId = generateId();
        await executeRqlite(
          `INSERT INTO widget_data_cache (id, widget_type, server_id, data, data_hash, storage_mode, collected_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now', '+' || ? || ' seconds'))`,
          [cacheId, widgetType, serverId, data, dataHash, storageMode || 'latest_ttl', ttlSec]
        );
        
        // Update last_polled_at
        await executeRqlite(
          `UPDATE widget_polling_config SET last_polled_at = CURRENT_TIMESTAMP WHERE widget_type = ? AND server_id = ?`,
          [widgetType, serverId]
        );
        
        console.log(`[Poller] Cached ${widgetType} data (${data.length} bytes)`);
        
      } catch (err) {
        console.error(`[Poller] Error polling ${widgetType}:`, err.message);
      }
    }
    
  } catch (err) {
    console.error('[Poller] Main loop error:', err.message);
  }
}

// Cleanup expired cache entries
async function cleanupExpired() {
  console.log('[Poller] Cleaning up expired cache...');
  
  try {
    await executeRqlite(
      `DELETE FROM widget_data_cache WHERE storage_mode = 'latest_ttl' AND expires_at < datetime('now')`
    );
    
    await executeRqlite(
      `DELETE FROM widget_data_cache WHERE storage_mode = 'change_only' AND collected_at < datetime('now', '-180 days')`
    );
    
  } catch (err) {
    console.error('[Poller] Cleanup error:', err.message);
  }
}

// Main
async function main() {
  console.log('[Poller] Widget poller service started');
  console.log('[Poller] RQLITE_HOST:', RQLITE_HOST);

  setInterval(pollWidgets, POLL_INTERVAL_MS);
  setInterval(cleanupExpired, 60000);

  setTimeout(pollWidgets, 2000);

  startHealthServer();
}

const HEALTH_PORT = parseInt(process.env.POLLER_HEALTH_PORT) || 3003;
let lastPollAt = null;

// Exposes GET /health so the app's system-health check can confirm the poller
// is running, and reports when the last poll cycle started.
function startHealthServer() {
  http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        service: 'poller',
        last_poll_at: lastPollAt,
        poll_interval_ms: POLL_INTERVAL_MS,
      }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bosun Poller');
  }).listen(HEALTH_PORT, '0.0.0.0', () => {
    console.log('[Poller] Health endpoint on port', HEALTH_PORT);
  });
}

main();

process.on('SIGINT', () => {
  console.log('[Poller] Shutting down...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('[Poller] Shutting down...');
  process.exit(0);
});