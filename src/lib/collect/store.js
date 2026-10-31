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
/** Raw sample plus rollup upserts for a set of { metric: number } at one moment. */
function metricStatements(serverId, metrics, nowMs) {
  const stmts = [];
  const ts = Math.floor(nowMs / 1000);
  for (const [metric, value] of Object.entries(metrics || {})) {
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
  return stmts;
}

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

  stmts.push(...metricStatements(serverId, snap.metrics, nowMs));

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
  return caps;
}

/**
 * Retention.
 */

/** SQL LIKE pattern (used with ESCAPE '!') for a metric name; `*` matches anything. */
function likeFor(name) {
  return String(name).replace(/[!%_]/g, (c) => '!' + c).replace(/\*/g, '%');
}

/** Merge metric definitions of several widgets: the longest retention wins per name pattern. */
function mergeDefinitions(defs, cfg) {
  const by = new Map();
  for (const d of defs || []) {
    const cur = by.get(d.pattern) || { pattern: d.pattern, rawHours: 0, rollup5mDays: 0, rollup1hDays: 0 };
    cur.rawHours = Math.max(cur.rawHours, Number(d.raw_hours) || cfg.rawHours);
    cur.rollup5mDays = Math.max(cur.rollup5mDays, Number(d.rollup_5m_days) || cfg.rollup5mDays);
    cur.rollup1hDays = Math.max(cur.rollup1hDays, Number(d.rollup_1h_days) || cfg.rollup1hDays);
    by.set(d.pattern, cur);
  }
  return Array.from(by.values());
}

/**
 * Retention deletes. cfg: { rawHours, rollup5mDays, rollup1hDays } is the global setting; `defs` are rows of
 * metric_definitions ({ pattern, raw_hours, rollup_5m_days, rollup_1h_days }) from package widgets, which keep
 * the metrics they name for their own time instead (the longest wins when several widgets name one).
 */
function retentionStatements(cfg, nowMs, defs) {
  const now = Math.floor(nowMs / 1000);
  const merged = mergeDefinitions(defs, cfg);
  const likes = merged.map((m) => likeFor(m.pattern));
  const notCovered = likes.length ? ' AND NOT (' + likes.map(() => "metric LIKE ? ESCAPE '!'").join(' OR ') + ')' : '';
  const stmts = [
    { sql: 'DELETE FROM metric_samples WHERE ts < ?' + notCovered, params: [now - Math.round(cfg.rawHours * 3600), ...likes] },
    { sql: 'DELETE FROM metric_rollups WHERE resolution = 300 AND bucket < ?' + notCovered, params: [now - Math.round(cfg.rollup5mDays * 86400), ...likes] },
    { sql: 'DELETE FROM metric_rollups WHERE resolution = 3600 AND bucket < ?' + notCovered, params: [now - Math.round(cfg.rollup1hDays * 86400), ...likes] },
  ];
  merged.forEach((m, i) => {
    const like = " AND metric LIKE ? ESCAPE '!'";
    stmts.push({ sql: 'DELETE FROM metric_samples WHERE ts < ?' + like, params: [now - Math.round(m.rawHours * 3600), likes[i]] });
    stmts.push({ sql: 'DELETE FROM metric_rollups WHERE resolution = 300 AND bucket < ?' + like, params: [now - Math.round(m.rollup5mDays * 86400), likes[i]] });
    stmts.push({ sql: 'DELETE FROM metric_rollups WHERE resolution = 3600 AND bucket < ?' + like, params: [now - Math.round(m.rollup1hDays * 86400), likes[i]] });
  });
  return stmts;
}

module.exports = { buildPollStatements, metricStatements, retentionStatements, mergeDefinitions, likeFor, capabilitiesOf, macAutofillStatements, hashOf, ROLLUP_RESOLUTIONS };
