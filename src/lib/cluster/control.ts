import fs from 'fs';
import { rqlite } from '@/lib/db/rqlite-client';
import * as clusterConfig from './config';
import * as secrets from '@/lib/secrets';
import { encrypt, decrypt } from '@/lib/crypto/keys';
import { JOIN_TOKEN_KEY_PREFIX, JOIN_TOKEN_TTL_MS, cleanWebOrigins, isTokenId, newToken, openSecrets, proofMatches, sealSecrets, tokenProof, type SealedSecrets } from './join-token';

/**
 * Cluster management actions behind Settings > Cluster and the setup page.
 *
 * Settings changes are written to the cluster settings file and applied by
 * restarting this node's rqlite: the web app runs as the same user as
 * rqlited, so it can stop it; s6 restarts it and the start script (as root)
 * applies the pending action before rqlited comes back.
 */

const err = (message: string, status = 400) => Object.assign(new Error(message), { status });

/** Stop the local rqlited so s6 restarts it with the new settings. */
export function restartLocalRqlite(): number {
  for (const pid of fs.readdirSync('/proc').filter(p => /^\d+$/.test(p))) {
    try {
      const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      if (cmd.split('\0')[0].endsWith('rqlited')) {
        process.kill(Number(pid), 'SIGTERM');
        return Number(pid);
      }
    } catch { /* process gone or not ours */ }
  }
  throw err('rqlited process not found (not running inside the Bosun container?)', 500);
}

/** As restartLocalRqlite, but a node whose rqlited is not up yet (a failed join keeps it restarting) is fine: s6 starts it and applies the pending action. */
function restartLocalRqliteIfRunning(): void {
  try {
    restartLocalRqlite();
  } catch (e) {
    if ((e as { status?: number }).status !== 500) throw e;
  }
}

// ---- join codes ----

/** Version 1 (older Bosun): the secrets themselves. Still accepted when joining a cluster that runs an older version. */
export interface JoinCodeV1 {
  v: 1;
  /** Expiry (epoch ms). */
  exp: number;
  members: { id: string; raft: string }[];
  mk: string;
  as: string;
}

/** Version 2: a one-time token, exchanged at one of `web` for the secrets (see join-token.ts). */
export interface JoinCodeV2 {
  v: 2;
  exp: number;
  members: { id: string; raft: string }[];
  /** Origins of the cluster's web app to exchange the token at. */
  web: string[];
  /** Token id and secret (base64url). */
  id: string;
  s: string;
}

export type JoinCode = JoinCodeV1 | JoinCodeV2;

const PREFIX = 'BOSUN-JOIN-1.';
const PREFIX_V2 = 'BOSUN-JOIN-2.';

export function encodeJoinCode(c: JoinCode): string {
  return (c.v === 2 ? PREFIX_V2 : PREFIX) + Buffer.from(JSON.stringify(c)).toString('base64url');
}

export function decodeJoinCode(code: string, now = Date.now()): JoinCode {
  const trimmed = String(code || '').replace(/\s+/g, '');
  const prefix = trimmed.startsWith(PREFIX_V2) ? PREFIX_V2 : trimmed.startsWith(PREFIX) ? PREFIX : null;
  if (!prefix) throw err('Not a Bosun join code');
  let c: JoinCode;
  try {
    c = JSON.parse(Buffer.from(trimmed.slice(prefix.length), 'base64url').toString('utf8'));
  } catch {
    throw err('The join code is damaged (copy it again)');
  }
  if (!c || !Array.isArray(c.members) || !c.members.length) throw err('The join code is incomplete');
  if (prefix === PREFIX && (c.v !== 1 || !c.mk || !c.as)) throw err('The join code is incomplete');
  if (prefix === PREFIX_V2 && (c.v !== 2 || !isTokenId(c.id) || typeof c.s !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(c.s) || !cleanWebOrigins(c.web).length)) {
    throw err('The join code is incomplete');
  }
  if (typeof c.exp !== 'number' || c.exp < now) throw err('The join code has expired; create a new one on the cluster');
  for (const m of c.members) {
    if (!clusterConfig.isValidNodeId(m.id) || !clusterConfig.isValidAddr(m.raft)) throw err('The join code contains an invalid member');
  }
  return c;
}

/**
 * A join code for this cluster (admin only). It holds a one-time token, not the secrets: the joining node exchanges it
 * once, within 24 hours, at one of `webOrigins` (the address the admin is using, then each member on port 3042).
 */
export async function createJoinCode(webOrigins: string[] = []): Promise<{ code: string; expires_at: string; members: JoinCodeV2['members'] }> {
  const eff = clusterConfig.effectiveClusterConfig();
  if (!eff.cluster_ready) throw err('Enable clustering first: this node only advertises a local address.', 409);
  const nodes = await rqlite.getNodes();
  const members = nodes.filter(n => n.voter && n.addr).map(n => ({ id: n.id, raft: n.addr }));
  if (!members.length) throw err('Could not read the cluster membership', 503);
  const masterKey = secrets.getMasterKey();
  if (!masterKey) throw err('The cluster secrets are not available on this node', 503);
  const exp = Date.now() + JOIN_TOKEN_TTL_MS;
  const web = cleanWebOrigins([...webOrigins, ...members.map(m => `http://${hostOf(m.raft)}:3042`)]);
  const token = newToken();
  // Expired tokens are dropped whenever a new one is made.
  const old = await rqlite.query("SELECT key, value FROM app_config WHERE substr(key, 1, ?) = ?", [JOIN_TOKEN_KEY_PREFIX.length, JOIN_TOKEN_KEY_PREFIX]);
  const stale = (old.values || []).filter(([, v]) => { try { return JSON.parse(String(v)).exp < Date.now(); } catch { return true; } }).map(([k]) => String(k));
  await rqlite.executeBatch([
    ...stale.map(k => ({ sql: 'DELETE FROM app_config WHERE key = ?', params: [k] })),
    {
      sql: 'INSERT INTO app_config (key, value, description) VALUES (?, ?, ?)',
      params: [JOIN_TOKEN_KEY_PREFIX + token.id, JSON.stringify({ s: encrypt(token.secret, masterKey), exp }), 'One-time cluster join token (secret encrypted)'],
    },
  ]);
  return {
    code: encodeJoinCode({ v: 2, exp, members, web, id: token.id, s: token.secret }),
    expires_at: new Date(exp).toISOString(),
    members,
  };
}

function hostOf(raft: string): string {
  const i = raft.lastIndexOf(':');
  return i > 0 ? raft.slice(0, i) : raft;
}

/**
 * The cluster side of the exchange: check the proof, use the token up (only one request can delete it), and answer
 * with the secrets sealed for the token holder. Throws a 404-style error for anything unknown, used or expired.
 */
export async function redeemJoinToken(id: unknown, proof: unknown): Promise<SealedSecrets> {
  const gone = () => err('This join code is not valid (used, expired or unknown); create a new one on the cluster', 404);
  if (!isTokenId(id)) throw gone();
  const masterKey = secrets.getMasterKey();
  const authSecret = secrets.getAuthSecret();
  if (!masterKey || !authSecret) throw err('The cluster secrets are not available on this node', 503);
  const row = await rqlite.query('SELECT value FROM app_config WHERE key = ?', [JOIN_TOKEN_KEY_PREFIX + id]);
  const value = row.values?.[0]?.[0];
  if (typeof value !== 'string') throw gone();
  let stored: { s: string; exp: number };
  try { stored = JSON.parse(value); } catch { throw gone(); }
  if (!(stored.exp > Date.now())) throw gone();
  let secret: string;
  try { secret = decrypt(stored.s, masterKey); } catch { throw gone(); }
  if (!proofMatches(id, secret, proof)) throw gone();
  // Delete exactly the row that was read: of two requests racing with the same token only one succeeds.
  const del = await rqlite.execute('DELETE FROM app_config WHERE key = ? AND value = ?', [JOIN_TOKEN_KEY_PREFIX + id, value]);
  if (del.rows_affected !== 1) throw gone();
  return sealSecrets(id, secret, { mk: masterKey, as: authSecret });
}

/** The joining side: exchange a version 2 code at the first member that answers. */
async function exchangeJoinCode(c: JoinCodeV2): Promise<{ mk: string; as: string }> {
  const proof = tokenProof(c.id, c.s);
  let lastError = 'no member answered';
  for (const origin of cleanWebOrigins(c.web)) {
    try {
      const res = await fetch(`${origin}/api/setup/join-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: c.id, proof }),
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
      const json = await res.json().catch(() => null) as { data?: SealedSecrets; error?: { message?: string } } | null;
      if (res.ok && json?.data) return openSecrets(c.id, c.s, json.data);
      // The token was checked and refused: another member will refuse it too.
      if (res.status === 404 || res.status === 429) throw err(json?.error?.message || `${origin} refused the join code`, res.status === 404 ? 400 : 429);
      lastError = `${origin}: HTTP ${res.status}`;
    } catch (e) {
      if ((e as { status?: number }).status) throw e;
      lastError = `${origin}: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  throw err(`Could not reach the cluster to redeem the join code (${lastError}). This node must be able to open the cluster's Bosun web address.`, 502);
}
// ---- actions ----

async function voters() {
  const nodes = await rqlite.getNodes();
  return nodes.filter(n => n.voter);
}

/**
 * Single node -> cluster-ready: set the address other nodes will use (and
 * optionally a new node id) and rewrite this node's own Raft membership.
 */
export async function enableClustering(advHost: string, nodeId?: string): Promise<void> {
  if (!clusterConfig.isValidHost(advHost) || advHost === 'localhost' || advHost.startsWith('127.')) {
    throw err('Enter an address the other machines can reach (LAN IP or DNS name)');
  }
  if (nodeId !== undefined && !clusterConfig.isValidNodeId(nodeId)) throw err('Node name: letters, digits, dot, dash, underscore');
  if ((await voters()).length > 1) throw err('This node is already part of a multi-node cluster', 409);
  clusterConfig.writeClusterFile({
    adv_host: advHost,
    ...(nodeId ? { node_id: nodeId } : {}),
    join: [],
    pending: 'readdress',
  });
  restartLocalRqlite();
}

/** Remove a member (dead or decommissioned) from the cluster membership. */
export async function removeNode(nodeId: string): Promise<void> {
  const nodes = await rqlite.getNodes();
  const self = clusterConfig.effectiveClusterConfig().node_id;
  if (nodeId === self) throw err('A node cannot remove itself; use "Convert to single node" on the node that stays');
  if (!nodes.some(n => n.id === nodeId)) throw err('No such node', 404);
  const leader = nodes.find(n => n.leader && n.reachable);
  if (!leader) throw err('The cluster has no leader; removing nodes needs a majority. Use "Convert to single node" if the others are gone.', 503);
  const base = leader.id === self || !leader.api_addr ? `http://localhost:${process.env.RQLITE_HTTP_PORT || '4001'}` : leader.api_addr;
  const res = await fetch(`${base}/remove`, {
    method: 'DELETE',
    headers: { ...secrets.rqliteAuthHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: nodeId }),
    cache: 'no-store',
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw err(`rqlite refused to remove ${nodeId}: ${(await res.text()).trim().slice(0, 200)}`, 502);
}

/**
 * Make this node a one-node cluster. With a majority available the other
 * nodes are removed through Raft (no restart); without one (the others are
 * gone) the membership is rewritten on restart, as in disaster recovery.
 */
export async function convertToSingle(): Promise<{ method: 'removed' | 'forced'; removed: string[] }> {
  const self = clusterConfig.effectiveClusterConfig().node_id;
  if (await rqlite.isReady()) {
    // Followers first, the leader (if it is not this node) last.
    const others = (await rqlite.getNodes()).filter(n => n.id !== self).sort((a, b) => Number(a.leader) - Number(b.leader));
    const removed: string[] = [];
    for (const n of others) {
      await removeNode(n.id);
      removed.push(n.id);
    }
    clusterConfig.writeClusterFile({ join: [] });
    return { method: 'removed', removed };
  }
  clusterConfig.writeClusterFile({ join: [], pending: 'force_single' });
  restartLocalRqlite();
  return { method: 'forced', removed: [] };
}

/**
 * Setup page: join this fresh node to an existing cluster with a join code.
 * Adopts the cluster secrets, then wipes this node's empty database and
 * restarts rqlite with the cluster as join targets.
 */
export async function joinCluster(code: string, advHost: string, nodeId: string): Promise<JoinCode['members']> {
  const c = decodeJoinCode(code);
  if (!clusterConfig.isValidHost(advHost) || advHost === 'localhost' || advHost.startsWith('127.')) {
    throw err('Enter this machine\'s address as the other nodes reach it (LAN IP or DNS name)');
  }
  if (!clusterConfig.isValidNodeId(nodeId)) throw err('Node name: letters, digits, dot, dash, underscore');
  if (c.members.some(m => m.id === nodeId)) throw err(`The cluster already has a node called "${nodeId}"; choose another name`);
  if (c.members.some(m => m.raft.split(':')[0] === advHost)) throw err('That address already belongs to a cluster member');
  // Version 2: exchange the one-time token for the secrets now (it is used up whether or not the join then works).
  const s = c.v === 2 ? await exchangeJoinCode(c) : { mk: c.mk, as: c.as };
  try {
    secrets.adoptClusterSecrets(s.mk, s.as);
  } catch (e) {
    throw err(e instanceof Error ? e.message : String(e), 409);
  }
  clusterConfig.writeClusterFile({
    node_id: nodeId,
    adv_host: advHost,
    join: c.members.map(m => m.raft),
    pending: 'wipe_and_join',
    join_started_at: new Date().toISOString(),
  });
  restartLocalRqliteIfRunning();
  return c.members;
}

/**
 * Give up a join that never completed: discard the local database and start
 * as a fresh node, so /setup works again (new installation or another attempt)
 * without wiping the data volume by hand.
 */
export function abortJoin(): void {
  clusterConfig.writeClusterFile({ join: [], pending: 'abort_join', join_started_at: null });
  restartLocalRqliteIfRunning();
}
