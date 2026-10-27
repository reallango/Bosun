'use strict';

/**
 * Builds the rqlite statements that persist one poll of one host.
 *
 * Everything for a poll goes into a single transactional batch:
 *  - host_snapshots: latest JSON per section (only rewritten when the content
 *    hash changed; otherwise just collected_at is bumped)
 *  - metric_samples: raw numeric samples (epoch seconds)
 *  - metric_rollups: 5-minute and 1-hour aggregates updated incrementally
 *    (running mean, min, max, count), so no separate downsampling job exists
 *    and history survives raw-sample retention.
 *  - servers: online flag, last_seen, capabilities and detected OS fields
 */

const crypto = require('crypto');

const ROLLUP_RESOLUTIONS = [300, 3600];

function hashOf(data) {
  return crypto.createHash('sha1').update(JSON.stringify(data)).digest('hex');
}

/**
 * @param {string} serverId
 * @param {{sections: object, metrics: object}} snap
 * @param {number} nowMs
 * @param {Map<string,string>} hashes  section -> last written hash (mutated)
 */
function buildPollStatements(serverId, snap, nowMs, hashes) {
  const stmts = [];
  const ts = Math.floor(nowMs / 1000);

  for (const [section, data] of Object.entries(snap.sections)) {
    const h = hashOf(data);
    if (hashes && hashes.get(section) === h) {
      stmts.push({ sql: 'UPDATE host_snapshots SET collected_at = ? WHERE server_id = ? AND section = ?', params: [nowMs, serverId, section] });
      continue;
    }
    stmts.push({
      sql: 'INSERT INTO host_snapshots (server_id, section, data, data_hash, collected_at) VALUES (?, ?, ?, ?, ?) ' +
        'ON CONFLICT(server_id, section) DO UPDATE SET data = excluded.data, data_hash = excluded.data_hash, collected_at = excluded.collected_at',
      params: [serverId, section, JSON.stringify(data), h, nowMs],
    });
    if (hashes) hashes.set(section, h);
  }

  for (const [metric, value] of Object.entries(snap.metrics)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    stmts.push({ sql: 'INSERT OR REPLACE INTO metric_samples (server_id, metric, ts, value) VALUES (?, ?, ?, ?)', params: [serverId, metric, ts, value] });
    for (const res of ROLLUP_RESOLUTIONS) {
      const bucket = ts - (ts % res);
      stmts.push({
        sql: 'INSERT INTO metric_rollups (server_id, metric, resolution, bucket, avg, "min", "max", n) VALUES (?, ?, ?, ?, ?, ?, ?, 1) ' +
          'ON CONFLICT(server_id, metric, resolution, bucket) DO UPDATE SET ' +
          'avg = (metric_rollups.avg * metric_rollups.n + excluded.avg) / (metric_rollups.n + 1), ' +
          '"min" = MIN(metric_rollups."min", excluded."min"), "max" = MAX(metric_rollups."max", excluded."max"), n = metric_rollups.n + 1',
        params: [serverId, metric, res, bucket, value, value, value],
      });
    }
  }

  // Server row: liveness, plus OS/CPU facts whenever the system section ran.
  const sys = snap.sections.system;
  if (sys) {
    const mem = snap.sections.cpu_memory && snap.sections.cpu_memory.memory;
    stmts.push({
      sql: 'UPDATE servers SET is_online = 1, last_seen = CURRENT_TIMESTAMP, last_error = NULL, os_type = ?, os_version = ?, os_codename = ?, ' +
        'kernel_version = ?, cpu_model = ?, cpu_cores = ?, total_ram_mb = COALESCE(?, total_ram_mb) WHERE id = ?',
      params: [sys.id || null, sys.version || null, sys.codename || null, sys.kernel || null, sys.cpuModel || null,
        sys.cpuThreads || null, mem ? mem.totalMB : null, serverId],
    });
  } else {
    stmts.push({ sql: 'UPDATE servers SET is_online = 1, last_seen = CURRENT_TIMESTAMP, last_error = NULL WHERE id = ?', params: [serverId] });
  }
  return stmts;
}

/**
 * Fill in Wake-on-LAN MACs the host reports, but only where the server has
 * none yet (NULL). A user-entered value is never overwritten, and an empty
 * string (the user cleared it) means "leave empty". The alternate MAC is the
 * wired/wireless counterpart and must differ from the primary.
 */
function macAutofillStatements(serverId, nics) {
  const stmts = [];
  if (!nics) return stmts;
  if (nics.primary) {
    stmts.push({ sql: 'UPDATE servers SET mac_address = ? WHERE id = ? AND mac_address IS NULL', params: [nics.primary.mac, serverId] });
  }
  if (nics.alt) {
    stmts.push({
      sql: 'UPDATE servers SET mac_address_alt = ? WHERE id = ? AND mac_address_alt IS NULL AND COALESCE(mac_address, \'\') <> ?',
      params: [nics.alt.mac, serverId, nics.alt.mac],
    });
  }
  return stmts;
}

/** Capabilities summary stored on the server row (drives widget suggestions). */
function capabilitiesOf(sections, prev) {
  const caps = { ...(prev || {}) };
  if (sections.gpus) caps.gpus = sections.gpus.length;
  if (sections.docker) caps.docker = !!sections.docker.available;
  if (sections.ollama) caps.ollama = sections.ollama.status === 'running';
  return caps;
}

/**
 * Retention deletes. cfg: { rawHours, rollup5mDays, rollup1hDays }.
 */
function retentionStatements(cfg, nowMs) {
  const now = Math.floor(nowMs / 1000);
  return [
    { sql: 'DELETE FROM metric_samples WHERE ts < ?', params: [now - Math.round(cfg.rawHours * 3600)] },
    { sql: 'DELETE FROM metric_rollups WHERE resolution = 300 AND bucket < ?', params: [now - Math.round(cfg.rollup5mDays * 86400)] },
    { sql: 'DELETE FROM metric_rollups WHERE resolution = 3600 AND bucket < ?', params: [now - Math.round(cfg.rollup1hDays * 86400)] },
  ];
}

module.exports = { buildPollStatements, retentionStatements, capabilitiesOf, macAutofillStatements, hashOf, ROLLUP_RESOLUTIONS };
