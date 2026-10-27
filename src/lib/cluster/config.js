'use strict';

/**
 * Cluster settings managed from the UI, stored on the data volume at
 * <data>/bosun/cluster.json and applied by the rqlite start script
 * (src/lib/cluster/boot.js) whenever rqlite (re)starts.
 *
 *   node_id   rqlite node id (unique per node)
 *   adv_host  address other nodes use to reach this one
 *   join      Raft addresses (host:port) of cluster members to join
 *   pending   one-shot action for the next rqlite start:
 *             'readdress'     rewrite this node's own address in the Raft
 *                             membership (single node -> cluster-ready)
 *             'force_single'  make this node a one-node cluster (recovery)
 *             'wipe_and_join' discard this node's (empty) database and join
 *
 * Values in the file win over the environment (NODE_NAME, RQLITE_ADV_HOST,
 * RQLITE_JOIN), which act as defaults. Dependency-free CommonJS.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.RQLITE_DATA_DIR || '/data/rqlite';
const FILE = process.env.BOSUN_CLUSTER_FILE || path.join(DATA_DIR, 'bosun', 'cluster.json');
const RAFT_PORT = process.env.RQLITE_RAFT_PORT || '4002';

const HOST_RE = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/;
const ADDR_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?:\d{1,5}$/;
const NODE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
const ACTIONS = ['readdress', 'force_single', 'wipe_and_join'];

function isValidHost(h) { return typeof h === 'string' && HOST_RE.test(h); }
function isValidAddr(a) { return typeof a === 'string' && ADDR_RE.test(a) && Number(a.split(':').pop()) <= 65535; }
function isValidNodeId(n) { return typeof n === 'string' && NODE_ID_RE.test(n); }

function readClusterFile() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return {};
  }
}

/** Validate and write the settings file (merging with what is there). */
function writeClusterFile(patch) {
  const next = { ...readClusterFile(), ...patch, updated_at: new Date().toISOString() };
  if (next.node_id !== undefined && next.node_id !== null && !isValidNodeId(next.node_id)) throw new Error('Invalid node id');
  if (next.adv_host !== undefined && next.adv_host !== null && !isValidHost(next.adv_host)) throw new Error('Invalid address');
  if (next.join !== undefined && (!Array.isArray(next.join) || !next.join.every(isValidAddr))) throw new Error('Invalid join list');
  if (next.pending !== undefined && next.pending !== null && !ACTIONS.includes(next.pending)) throw new Error('Invalid pending action');
  fs.mkdirSync(path.dirname(FILE), { recursive: true, mode: 0o700 });
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
  return next;
}

/** Effective settings: file values over environment over defaults, with sources. */
function effectiveClusterConfig(env = process.env) {
  const f = readClusterFile();
  const envJoin = (env.RQLITE_JOIN || '').split(',').map(s => s.trim()).filter(Boolean);
  const pick = (fileVal, envVal, def) => (fileVal !== undefined && fileVal !== null && fileVal !== ''
    ? { value: fileVal, source: 'ui' }
    : envVal ? { value: envVal, source: 'env' } : { value: def, source: 'default' });
  const nodeId = pick(f.node_id, env.NODE_NAME, 'node1');
  const advHost = pick(f.adv_host, env.RQLITE_ADV_HOST, 'localhost');
  const join = Array.isArray(f.join) ? { value: f.join, source: 'ui' } : envJoin.length ? { value: envJoin, source: 'env' } : { value: [], source: 'default' };
  return {
    node_id: nodeId.value,
    node_id_source: nodeId.source,
    adv_host: advHost.value,
    adv_host_source: advHost.source,
    raft_addr: `${advHost.value}:${RAFT_PORT}`,
    join: join.value,
    join_source: join.source,
    bootstrap_expect: f.bootstrap_expect || env.RQLITE_BOOTSTRAP_EXPECT || null,
    pending: f.pending || null,
    /** Reachable by other machines (not just this container)? */
    cluster_ready: advHost.value !== 'localhost' && advHost.value !== '127.0.0.1',
  };
}

module.exports = {
  CLUSTER_FILE: FILE, readClusterFile, writeClusterFile, effectiveClusterConfig,
  isValidHost, isValidAddr, isValidNodeId, ACTIONS,
};
