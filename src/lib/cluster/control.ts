import fs from 'fs';
import { rqlite } from '@/lib/db/rqlite-client';
import * as clusterConfig from './config';
import * as secrets from '@/lib/secrets';

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

// ---- join codes ----

export interface JoinCode {
  v: 1;
  /** Expiry (epoch ms). */
  exp: number;
  members: { id: string; raft: string }[];
  mk: string;
  as: string;
}

const PREFIX = 'BOSUN-JOIN-1.';
const CODE_TTL_MS = 24 * 3600 * 1000;

export function encodeJoinCode(c: JoinCode): string {
  return PREFIX + Buffer.from(JSON.stringify(c)).toString('base64url');
}

export function decodeJoinCode(code: string, now = Date.now()): JoinCode {
  const trimmed = String(code || '').replace(/\s+/g, '');
  if (!trimmed.startsWith(PREFIX)) throw err('Not a Bosun join code');
  let c: JoinCode;
  try {
    c = JSON.parse(Buffer.from(trimmed.slice(PREFIX.length), 'base64url').toString('utf8'));
  } catch {
    throw err('The join code is damaged (copy it again)');
  }
  if (c?.v !== 1 || !Array.isArray(c.members) || !c.members.length || !c.mk || !c.as) throw err('The join code is incomplete');
  if (typeof c.exp !== 'number' || c.exp < now) throw err('The join code has expired; create a new one on the cluster');
  for (const m of c.members) {
    if (!clusterConfig.isValidNodeId(m.id) || !clusterConfig.isValidAddr(m.raft)) throw err('The join code contains an invalid member');
  }
  return c;
}

/** A join code for this cluster (admin only; contains the cluster secrets). */
export async function createJoinCode(): Promise<{ code: string; expires_at: string; members: JoinCode['members'] }> {
  const eff = clusterConfig.effectiveClusterConfig();
  if (!eff.cluster_ready) throw err('Enable clustering first: this node only advertises a local address.', 409);
  const nodes = await rqlite.getNodes();
  const members = nodes.filter(n => n.voter && n.addr).map(n => ({ id: n.id, raft: n.addr }));
  if (!members.length) throw err('Could not read the cluster membership', 503);
  const exp = Date.now() + CODE_TTL_MS;
  return {
    code: encodeJoinCode({ v: 1, exp, members, mk: secrets.getMasterKey(), as: secrets.getAuthSecret() }),
    expires_at: new Date(exp).toISOString(),
    members,
  };
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
    headers: { 'Content-Type': 'application/json' },
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
  try {
    secrets.adoptClusterSecrets(c.mk, c.as);
  } catch (e) {
    throw err(e instanceof Error ? e.message : String(e), 409);
  }
  clusterConfig.writeClusterFile({
    node_id: nodeId,
    adv_host: advHost,
    join: c.members.map(m => m.raft),
    pending: 'wipe_and_join',
  });
  restartLocalRqlite();
  return c.members;
}
