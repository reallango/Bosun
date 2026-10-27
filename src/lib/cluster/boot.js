#!/usr/bin/env node
'use strict';

/**
 * Runs (as root) from the rqlite s6 start script before rqlited starts.
 * Applies a one-shot pending action from the UI-managed cluster settings and
 * prints the effective settings as shell assignments for the start script:
 *   BOSUN_NODE_ID, BOSUN_ADV_HOST, BOSUN_JOIN, BOSUN_EXPECT
 * Logs go to stderr. Never throws: on any problem it prints the environment
 * defaults so rqlite still starts.
 */

const fs = require('fs');
const path = require('path');
const cfg = require('./config');

const DATA = process.env.RQLITE_DATA_DIR || '/data/rqlite';
const log = m => process.stderr.write(`[cluster-boot] ${m}\n`);
const q = s => `'${String(s).replace(/'/g, `'\\''`)}'`;

function writePeers(nodeId, raftAddr) {
  const raftDir = path.join(DATA, 'raft');
  if (!fs.existsSync(raftDir)) return false;
  fs.writeFileSync(path.join(raftDir, 'peers.json'), JSON.stringify([{ id: nodeId, address: raftAddr, non_voter: false }]) + '\n');
  return true;
}

function wipeData() {
  for (const entry of fs.readdirSync(DATA)) {
    if (entry === 'bosun') continue; // settings and secrets
    fs.rmSync(path.join(DATA, entry), { recursive: true, force: true });
  }
}

function main() {
  const file = cfg.readClusterFile();
  const e = cfg.effectiveClusterConfig();
  let join = e.join;
  let expect = e.bootstrap_expect || '';

  if (file.pending) {
    const action = file.pending;
    if (action === 'readdress' || action === 'force_single') {
      const wrote = writePeers(e.node_id, e.raft_addr);
      log(`${action}: membership set to ${e.node_id} @ ${e.raft_addr}${wrote ? '' : ' (no existing raft state)'}`);
      if (action === 'force_single') join = [];
      expect = '';
      cfg.writeClusterFile({ pending: null, join: action === 'force_single' ? [] : file.join, last_action: { action, at: new Date().toISOString() } });
    } else if (action === 'wipe_and_join') {
      wipeData();
      log(`wipe_and_join: local database cleared; joining ${join.join(',')}`);
      expect = '';
      cfg.writeClusterFile({ pending: null, last_action: { action, at: new Date().toISOString() } });
    }
  }

  process.stdout.write([
    `BOSUN_NODE_ID=${q(e.node_id)}`,
    `BOSUN_ADV_HOST=${q(e.adv_host)}`,
    `BOSUN_JOIN=${q(join.join(','))}`,
    `BOSUN_EXPECT=${q(expect)}`,
  ].join('\n') + '\n');
}

try {
  main();
} catch (err) {
  log(`failed, using environment defaults: ${err.message}`);
}
