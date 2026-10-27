#!/usr/bin/env node
'use strict';

/**
 * Bosun host poller.
 *
 * The only process that collects monitoring data. Designed to be gentle on
 * monitored hosts:
 *  - one persistent SSH connection per host (keepalives, reused across polls);
 *  - one exec per poll running a batched, read-only script at nice 19 /
 *    ionice idle (PowerShell at BelowNormal on Windows);
 *  - probes are tiered: cheap counters every poll, docker/ollama/disks every
 *    minute, services/OS facts every few minutes, package updates every 6h;
 *  - CPU% and network rates come from counter deltas between polls, so
 *    nothing sleeps on the host;
 *  - failures back off exponentially (up to 5 minutes) and drop the
 *    connection; a host is marked offline after 2 consecutive failures.
 *
 * Results go to rqlite in one transaction per poll: latest snapshots per
 * section (host_snapshots), raw metric samples, and incrementally maintained
 * 5m/1h rollups. In a cluster only the raft leader polls.
 *
 * Environment:
 *   RQLITE_HOST          rqlite address (default 127.0.0.1:4001)
 *   MASTER_KEY           key used to decrypt stored SSH private keys (required)
 *   POLLER_HEALTH_PORT   health endpoint port (default 3003)
 *   POLLER_MAX_PARALLEL  hosts polled concurrently (default 8)
 */

const http = require('http');
const linux = require('./src/lib/collect/linux');
const windows = require('./src/lib/collect/windows');
const ssh = require('./src/lib/collect/ssh');
const store = require('./src/lib/collect/store');
const alerts = require('./src/lib/collect/alerts');

const RQLITE_HOST = process.env.RQLITE_HOST || '127.0.0.1:4001';
const MASTER_KEY = process.env.MASTER_KEY || '';
const HEALTH_PORT = parseInt(process.env.POLLER_HEALTH_PORT, 10) || 3003;
const MAX_PARALLEL = parseInt(process.env.POLLER_MAX_PARALLEL, 10) || 8;
const TICK_MS = 1000;
const MIN_INTERVAL_SEC = 5;
const MAX_BACKOFF_MS = 5 * 60 * 1000;

/** Probe tiers: [probes, period ms]. The fast tier runs every poll. */
const TIERS = {
  linux: [
    { name: 'fast', probes: ['stat', 'mem', 'load', 'temp', 'netdev', 'gpu'], periodMs: 0 },
    { name: 'medium', probes: ['df', 'ip', 'docker', 'ollama'], periodMs: 60 * 1000 },
    { name: 'slow', probes: ['services', 'system'], periodMs: 5 * 60 * 1000 },
    { name: 'updates', probes: ['updates'], periodMs: 6 * 3600 * 1000, initialDelayMs: 5 * 60 * 1000 },
  ],
  windows: [
    { name: 'fast', probes: ['stat', 'mem', 'netdev', 'gpu'], periodMs: 0 },
    { name: 'medium', probes: ['df', 'docker', 'ollama'], periodMs: 2 * 60 * 1000 },
    { name: 'slow', probes: ['ip', 'services', 'system'], periodMs: 15 * 60 * 1000 },
  ],
};

const log = (...a) => console.log('[Poller]', ...a);
const warn = (...a) => console.warn('[Poller]', ...a);

// ---------------------------------------------------------------- rqlite ---

async function rq(path, body, timeoutMs = 15000) {
  const res = await fetch(`http://${RQLITE_HOST}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`rqlite ${path} -> HTTP ${res.status}`);
  return res.json();
}

async function query(sql, params = []) {
  const json = await rq('/db/query', [[sql, ...params]]);
  const r = json.results && json.results[0];
  if (!r || r.error) throw new Error(`query failed: ${(r && r.error) || 'no result'}`);
  const cols = r.columns || [];
  return (r.values || []).map(row => Object.fromEntries(cols.map((c, i) => [c, row[i]])));
}

async function executeBatch(statements) {
  if (!statements.length) return;
  const json = await rq('/db/execute?transaction', statements.map(s => [s.sql, ...(s.params || [])]), 30000);
  const bad = (json.results || []).find(r => r && r.error);
  if (json.error || bad) throw new Error(`execute failed: ${json.error || bad.error}`);
}

async function isLeader() {
  const status = await rq('/status');
  const store_ = status.store || {};
  const raft = store_.raft || {};
  if (raft.state) return raft.state === 'Leader';
  return true; // single node without raft info
}

async function schemaReady() {
  try {
    const rows = await query('SELECT MAX(version) AS v FROM schema_migrations');
    return Number(rows[0] && rows[0].v) >= 1;
  } catch {
    return false;
  }
}

async function readRetention() {
  const cfg = { rawHours: 48, rollup5mDays: 30, rollup1hDays: 400 };
  try {
    const rows = await query("SELECT key, value FROM app_config WHERE key LIKE 'metrics.%'");
    for (const { key, value } of rows) {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) continue;
      if (key === 'metrics.raw_retention_hours') cfg.rawHours = n;
      if (key === 'metrics.rollup_5m_retention_days') cfg.rollup5mDays = n;
      if (key === 'metrics.rollup_1h_retention_days') cfg.rollup1hDays = n;
    }
  } catch (err) {
    warn('retention config read failed:', err.message);
  }
  return cfg;
}

// ------------------------------------------------------------ host agent ---

class HostAgent {
  constructor(row) {
    this.id = row.id;
    this.update(row);
    this.client = null;
    this.connecting = null;
    this.state = null; // counters from the previous poll
    this.hashes = new Map();
    this.tierLast = {};
    this.started = Date.now();
    this.nextDue = Date.now();
    this.failures = 0;
    this.busy = false;
    this.lastPollAt = null;
    this.lastDurationMs = null;
    this.lastError = null;
    this.polls = 0;
  }

  update(row) {
    const changed = this.row && ['hostname', 'ssh_port', 'ssh_user', 'ssh_key_id', 'platform', 'host_key_fingerprint']
      .some(k => this.row[k] !== row[k]);
    this.row = row;
    if (changed) {
      log(`${row.name}: connection settings changed, reconnecting`);
      this.close();
      this.state = null;
    }
  }

  get platform() {
    return this.row.platform === 'windows' ? 'windows' : 'linux';
  }

  get intervalMs() {
    const def = this.platform === 'windows' ? 30 : 15;
    return Math.max(MIN_INTERVAL_SEC, Number(this.row.poll_interval_sec) || def) * 1000;
  }

  close() {
    if (this.client) {
      try { this.client.end(); } catch { /* ignore */ }
    }
    this.client = null;
    this.connecting = null;
  }

  async ensureConnected() {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      if (!this.row.ssh_key_id) throw new Error('no SSH key assigned');
      const keys = await query('SELECT private_key_enc, passphrase_enc FROM ssh_keys WHERE id = ?', [this.row.ssh_key_id]);
      if (!keys.length) throw new Error('SSH key not found');
      const privateKey = ssh.decryptSecret(keys[0].private_key_enc, MASTER_KEY);
      const passphrase = keys[0].passphrase_enc ? ssh.decryptSecret(keys[0].passphrase_enc, MASTER_KEY) : undefined;
      const client = await ssh.connect({
        host: this.row.hostname,
        port: this.row.ssh_port || 22,
        username: this.row.ssh_user,
        privateKey,
        passphrase,
        expectedFingerprint: this.row.host_key_fingerprint || undefined,
        onNewFingerprint: (fp) => {
          this.row.host_key_fingerprint = fp;
          executeBatch([{ sql: 'UPDATE servers SET host_key_fingerprint = ? WHERE id = ? AND host_key_fingerprint IS NULL', params: [fp, this.id] }])
            .catch(err => warn(`${this.row.name}: storing host key failed:`, err.message));
        },
      });
      client.on('close', () => {
        if (this.client === client) {
          log(`${this.row.name}: connection closed`);
          this.client = null;
        }
      });
      client.on('error', (err) => warn(`${this.row.name}: connection error:`, err.message));
      this.client = client;
      log(`${this.row.name}: connected (${this.platform})`);
      return client;
    })();
    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  /** Probes due this poll; marks their tiers as run. */
  dueProbes(now, forceAll) {
    const probes = [];
    for (const tier of TIERS[this.platform]) {
      const last = this.tierLast[tier.name];
      let due;
      // Forced/initial polls refresh everything except tiers with an initial
      // delay (package updates), which keep their own schedule.
      if (tier.periodMs === 0 || (forceAll && !tier.initialDelayMs)) due = true;
      else if (last === undefined) due = now - this.started >= (tier.initialDelayMs || 0);
      else due = now - last >= tier.periodMs;
      if (due) {
        probes.push(...tier.probes);
        this.tierLast[tier.name] = now;
      }
    }
    return probes;
  }

  async poll({ forceAll = false } = {}) {
    this.busy = true;
    const started = Date.now();
    const lib = this.platform === 'windows' ? windows : linux;
    try {
      const client = await this.ensureConnected();
      // First poll after (re)connecting collects everything so widgets fill in.
      const probes = this.dueProbes(started, forceAll || this.polls === 0);
      const cmd = lib.buildCommand(probes);
      const r = await ssh.exec(client, cmd, {
        stdin: this.platform === 'windows' ? undefined : linux.SCRIPT,
        timeoutMs: probes.includes('updates') ? 120000 : 45000,
      });
      if (r.timedOut) throw new Error(`collection timed out after ${r.durationMs} ms`);
      const raw = lib.splitSections(r.stdout);
      if (!Object.keys(raw).length) {
        throw new Error(`no output from collector (exit ${r.exitCode}): ${(r.stderr || '').trim().slice(0, 200)}`);
      }
      const snap = lib.buildSnapshot(raw, this.state, Date.now());
      this.state = snap.state;

      const stmts = store.buildPollStatements(this.id, snap, Date.now(), this.hashes);
      const caps = store.capabilitiesOf(snap.sections, this.caps);
      if (JSON.stringify(caps) !== JSON.stringify(this.caps)) {
        this.caps = caps;
        stmts.push({ sql: 'UPDATE servers SET capabilities = ? WHERE id = ?', params: [JSON.stringify(caps), this.id] });
      }
      const fired = alerts.evaluateRules(alertRules, { id: this.id, name: this.row.name }, snap.metrics, Date.now(), alertLastFired);
      stmts.push(...alerts.alertStatements(fired, { id: this.id }, Date.now()));
      await executeBatch(stmts);
      if (fired.length) {
        log(`${this.row.name}: ${fired.length} alert(s) fired`);
        alerts.deliverWebhooks(fired, alertChannels).catch(err => warn('alert delivery failed:', err.message));
      }

      this.failures = 0;
      this.lastError = null;
      this.polls++;
      this.lastDurationMs = Date.now() - started;
      this.nextDue = started + this.intervalMs;
    } catch (err) {
      this.failures++;
      this.lastError = err.message;
      const backoff = Math.min(MAX_BACKOFF_MS, this.intervalMs * 2 ** Math.min(this.failures, 6));
      this.nextDue = Date.now() + backoff;
      warn(`${this.row.name}: poll failed (${this.failures}x, retry in ${Math.round(backoff / 1000)}s): ${err.message}`);
      // A failed exec usually means a dead connection; start clean next time.
      this.close();
      this.state = null;
      this.tierLast = { updates: this.tierLast.updates };
      this.polls = 0;
      const offline = this.failures >= 2 || err.code === 'HOST_KEY_MISMATCH' ? 0 : 1;
      executeBatch([{
        sql: 'UPDATE servers SET is_online = CASE WHEN ? = 0 THEN 0 ELSE is_online END, last_error = ? WHERE id = ?',
        params: [offline, String(err.message).slice(0, 500), this.id],
      }]).catch(e => warn('status update failed:', e.message));
    } finally {
      this.lastPollAt = new Date(started).toISOString();
      this.busy = false;
    }
  }

  status() {
    return {
      id: this.id, name: this.row.name, platform: this.platform, connected: !!this.client,
      intervalSec: this.intervalMs / 1000, failures: this.failures, lastPollAt: this.lastPollAt,
      lastDurationMs: this.lastDurationMs, lastError: this.lastError, nextDueInSec: Math.max(0, Math.round((this.nextDue - Date.now()) / 1000)),
    };
  }
}

// ------------------------------------------------------------- scheduler ---

const agents = new Map();
let leader = false;
let lastLeaderCheck = 0;
let lastServerSync = 0;
let lastRetention = 0;
let lastAlertSync = 0;
let alertRules = [];
let alertChannels = new Map();
const alertLastFired = new Map();

async function syncAlerts() {
  try {
    alertRules = await query('SELECT * FROM alert_rules WHERE enabled = 1');
    const ch = await query('SELECT id, type, config, enabled FROM notification_channels');
    alertChannels = new Map(ch.map(c => [c.id, c]));
  } catch (err) {
    warn('alert rule sync failed:', err.message);
  }
}
let lastTickAt = null;
let ticking = false;

async function syncServers() {
  const rows = await query(
    'SELECT id, name, hostname, ssh_port, ssh_user, ssh_key_id, platform, poll_enabled, poll_interval_sec, ' +
    'host_key_fingerprint, poll_requested_at, capabilities FROM servers');
  const seen = new Set();
  for (const row of rows) {
    if (Number(row.poll_enabled) !== 1) continue;
    seen.add(row.id);
    const a = agents.get(row.id);
    if (a) {
      a.update(row);
      // "Refresh" in the UI sets poll_requested_at; poll now with all tiers.
      if (row.poll_requested_at && row.poll_requested_at > (a.lastRequest || 0)) {
        a.lastRequest = row.poll_requested_at;
        a.forceNext = true;
        a.nextDue = Math.min(a.nextDue, Date.now());
      }
    } else {
      const agent = new HostAgent(row);
      agent.lastRequest = row.poll_requested_at || 0;
      try { agent.caps = JSON.parse(row.capabilities || '{}'); } catch { agent.caps = {}; }
      agents.set(row.id, agent);
      log(`${row.name}: added (${row.platform || 'linux'} ${row.hostname})`);
    }
  }
  for (const [id, a] of agents) {
    if (!seen.has(id)) {
      log(`${a.row.name}: removed or disabled`);
      a.close();
      agents.delete(id);
    }
  }
}

async function tick() {
  if (ticking) return;
  ticking = true;
  const now = Date.now();
  lastTickAt = new Date(now).toISOString();
  try {
    if (now - lastLeaderCheck > 30000) {
      lastLeaderCheck = now;
      const was = leader;
      leader = await isLeader().catch(() => false);
      if (was !== leader) log(leader ? 'this node is the raft leader; polling' : 'not the leader; idle');
      if (!leader) for (const a of agents.values()) a.close();
    }
    if (!leader) return;

    if (now - lastServerSync > 2000) {
      lastServerSync = now;
      await syncServers();
    }

    let running = [...agents.values()].filter(a => a.busy).length;
    for (const a of agents.values()) {
      if (running >= MAX_PARALLEL) break;
      if (a.busy || a.nextDue > now) continue;
      running++;
      const forceAll = !!a.forceNext;
      a.forceNext = false;
      a.poll({ forceAll }); // runs concurrently; errors handled inside
    }

    if (now - lastAlertSync > 30000) {
      lastAlertSync = now;
      await syncAlerts();
    }

    if (now - lastRetention > 10 * 60 * 1000) {
      lastRetention = now;
      const cfg = await readRetention();
      await executeBatch(store.retentionStatements(cfg, now)).catch(err => warn('retention failed:', err.message));
    }
  } catch (err) {
    warn('tick failed:', err.message);
  } finally {
    ticking = false;
  }
}

function startHealthServer() {
  http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok', service: 'poller', leader, last_tick_at: lastTickAt,
        hosts: [...agents.values()].map(a => a.status()),
      }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Bosun Poller');
  }).listen(HEALTH_PORT, '127.0.0.1', () => log('health endpoint on 127.0.0.1:' + HEALTH_PORT));
}

async function main() {
  if (!MASTER_KEY) {
    console.error('[Poller] MASTER_KEY is not set; cannot decrypt SSH keys. Exiting.');
    process.exit(1);
  }
  log('starting; rqlite at', RQLITE_HOST);
  startHealthServer();
  while (!(await schemaReady())) {
    log('waiting for the database schema (the web app creates it on startup)...');
    await new Promise(r => setTimeout(r, 3000));
  }
  setInterval(tick, TICK_MS);
  tick();
}

function shutdown() {
  log('shutting down');
  for (const a of agents.values()) a.close();
  process.exit(0);
}



if (require.main === module) {
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  main();
}

module.exports = { HostAgent, TIERS };
