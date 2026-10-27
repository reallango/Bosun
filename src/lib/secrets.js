'use strict';

/**
 * MASTER_KEY (encrypts stored SSH keys, SMTP password, TOTP seeds) and
 * AUTH_SECRET (signs login/terminal tokens).
 *
 * Environment variables win. Without them the values live in
 * <data volume>/bosun/secrets.json: generated on first use for a new
 * deployment, or written from a join code when a node joins a cluster (every
 * node of a cluster must share them). The file is re-read when it changes, so
 * all processes pick up secrets written by a join without a restart.
 *
 * Dependency-free CommonJS: used by poller.js, ws-server.js and Next.js.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.RQLITE_DATA_DIR || '/data/rqlite';
const FILE = process.env.BOSUN_SECRETS_FILE || path.join(DATA_DIR, 'bosun', 'secrets.json');

let cache = null;
let cacheMtime = 0;

function readFile() {
  try {
    const st = fs.statSync(FILE);
    if (cache && st.mtimeMs === cacheMtime) return cache;
    cache = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    cacheMtime = st.mtimeMs;
    return cache;
  } catch {
    return null;
  }
}

function writeFile(data, { exclusive = false } = {}) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true, mode: 0o700 });
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  if (exclusive && fs.existsSync(FILE)) {
    fs.unlinkSync(tmp);
    return false;
  }
  fs.renameSync(tmp, FILE);
  cache = null;
  return true;
}

/** Generate secrets for a brand-new deployment (no env, no file yet). */
function ensureGenerated() {
  if (readFile()) return readFile();
  try {
    writeFile({
      master_key: crypto.randomBytes(32).toString('base64'),
      auth_secret: crypto.randomBytes(32).toString('base64'),
      generated_at: new Date().toISOString(),
    }, { exclusive: true });
  } catch {
    // Not writable (e.g. dev outside the container): fall through to null.
  }
  return readFile();
}

function get(envName, key) {
  if (process.env[envName]) return process.env[envName];
  const f = ensureGenerated();
  return (f && f[key]) || '';
}

function getMasterKey() {
  return get('MASTER_KEY', 'master_key');
}

function getAuthSecret() {
  return get('AUTH_SECRET', 'auth_secret');
}

/** Where each secret comes from (for the UI; never returns the values). */
function secretSources() {
  const f = readFile();
  return {
    master_key: process.env.MASTER_KEY ? 'env' : f && f.master_key ? 'file' : 'none',
    auth_secret: process.env.AUTH_SECRET ? 'env' : f && f.auth_secret ? 'file' : 'none',
  };
}

/**
 * Replace the stored secrets with the cluster's (node join). Refuses when the
 * environment pins different values, since env would keep winning.
 */
function adoptClusterSecrets(masterKey, authSecret) {
  if (process.env.MASTER_KEY && process.env.MASTER_KEY !== masterKey) {
    throw new Error('This node sets MASTER_KEY in its environment and it differs from the cluster. Remove it (or set it to the cluster value) and restart.');
  }
  if (process.env.AUTH_SECRET && process.env.AUTH_SECRET !== authSecret) {
    throw new Error('This node sets AUTH_SECRET in its environment and it differs from the cluster. Remove it (or set it to the cluster value) and restart.');
  }
  writeFile({ master_key: masterKey, auth_secret: authSecret, adopted_at: new Date().toISOString() });
}

module.exports = { getMasterKey, getAuthSecret, secretSources, adoptClusterSecrets, SECRETS_FILE: FILE };
