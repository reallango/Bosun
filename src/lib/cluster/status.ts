import { rqlite, ClusterNode } from '@/lib/db/rqlite-client';

export interface ClusterSummary {
  /** This Bosun node (NODE_NAME / rqlite node id). */
  node_id: string | null;
  is_leader: boolean;
  leader_id: string | null;
  /** A leader exists, so reads are current and writes work. */
  has_quorum: boolean;
  voters: number;
  reachable_voters: number;
  /** Voters that must be up for the cluster to have a leader. */
  quorum_size: number;
  nodes: ClusterNode[];
  poller: { node: string; at: string; stale: boolean } | null;
  /** This node served reads from its local copy recently (no leader). */
  degraded: boolean;
  state: 'ok' | 'reduced' | 'no_quorum' | 'single';
}

/** Majority of voters needed for raft to elect a leader. */
export function quorumSize(voters: number): number {
  return Math.floor(voters / 2) + 1;
}

/**
 * Overall state: ok = all voters reachable; reduced = a leader exists but
 * some voters are down (one more failure may lose quorum on 3 nodes);
 * no_quorum = no leader, read-only; single = one-node deployment.
 */
export function clusterState(voters: number, reachable: number, hasLeader: boolean): ClusterSummary['state'] {
  if (!hasLeader) return 'no_quorum';
  if (voters <= 1) return 'single';
  return reachable < voters ? 'reduced' : 'ok';
}

export async function getClusterSummary(): Promise<ClusterSummary> {
  let status: any = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { status = await rqlite.getStatus(); } catch { /* rqlite down */ }
  const store = status?.store || {};
  const nodeId: string | null = store.node_id ?? store.raft?.node_id ?? null;
  const raftState: string | undefined = store.raft?.state;

  let nodes: ClusterNode[] = [];
  try { nodes = await rqlite.getNodes(); } catch { /* fall back to status only */ }
  const hasLeader = await rqlite.isReady();
  if (!nodes.length && nodeId) {
    nodes = [{ id: nodeId, api_addr: null, addr: store.addr || '', voter: true, reachable: true, leader: raftState === 'Leader' }];
  }
  const voters = nodes.filter(n => n.voter);
  const reachable = voters.filter(n => n.reachable).length;
  const leader = nodes.find(n => n.leader) || null;

  let poller: ClusterSummary['poller'] = null;
  try {
    const r = await rqlite.query("SELECT value FROM app_config WHERE key = 'poller.active'");
    const v = r.values?.[0]?.[0];
    if (v) {
      const p = JSON.parse(String(v));
      poller = { node: p.node, at: p.at, stale: Date.now() - Date.parse(p.at) > 60_000 };
    }
  } catch { /* table missing or unreadable */ }

  return {
    node_id: nodeId,
    is_leader: raftState === 'Leader',
    leader_id: hasLeader ? leader?.id ?? null : null,
    has_quorum: hasLeader,
    voters: voters.length,
    reachable_voters: reachable,
    quorum_size: quorumSize(voters.length || 1),
    nodes,
    poller,
    degraded: rqlite.isDegraded() || !hasLeader,
    state: clusterState(voters.length, reachable, hasLeader),
  };
}
