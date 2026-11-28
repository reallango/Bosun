/**
 * The Bosun nodes of the cluster for self-update: which server and container each runs in (each node records its own,
 * `update.node.<node>` in app_config) and which version each runs right now (its public /api/health).
 */
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';
import { getConfig } from '@/lib/db/migrations';
import { detectNodeHost, nodeName, ownContainerIds } from '@/lib/network/node-host';
import { WIDGET_API_LEVEL } from '@/lib/widgets/api-level';
import { bosunVersion } from './version';

export interface NodeRecord { server_id: string | null; container_id: string | null; commit: string; at: string }
export interface NodeStatus {
  id: string;
  leader: boolean;
  reachable: boolean;
  web: string | null;
  healthy: boolean;
  commit: string | null;
  channel: string | null;
  /** The node's widget API level from /api/health; null when it is unreachable or runs a build without the field. */
  apiLevel: number | null;
  record: NodeRecord | null;
  self: boolean;
}

const DEFAULT_WEB_PORT = 3042;

/** Bosun's web port, as configured for self-update (nodes answer /api/health there). */
export async function configuredWebPort(): Promise<number> {
  const port = Number(await getConfig('update.web_port'));
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_WEB_PORT;
}

const key = (node: string) => `update.node.${node.replace(/[^A-Za-z0-9_.-]/g, '_')}`;

/** Remember which server and container this node runs in (started at boot and refreshed by the update check). */
export async function recordSelf(): Promise<NodeRecord> {
  const serverId = await detectNodeHost().catch(() => null);
  const ids = ownContainerIds();
  const rec: NodeRecord = {
    server_id: serverId, container_id: ids.find(i => i.length === 64) ?? ids[0] ?? null, commit: bosunVersion().commit, at: new Date().toISOString(),
  };
  await rqlite.execute(
    `INSERT INTO app_config (key, value, description, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
    [key(nodeName()), JSON.stringify(rec), 'Where this Bosun node runs (for self-update)']);
  return rec;
}

/** Every node's recorded server and container, keyed by node id (as stored, which is the id with unsafe characters replaced). */
export async function records(): Promise<Map<string, NodeRecord>> {
  const r = await rqlite.query("SELECT key, value FROM app_config WHERE substr(key, 1, 12) = 'update.node.'");
  const out = new Map<string, NodeRecord>();
  for (const row of rowsToObjects(r)) {
    try { out.set(String(row.key).slice('update.node.'.length), JSON.parse(String(row.value))); } catch { /* skip */ }
  }
  return out;
}

/** A node's web address: the host of its database address with Bosun's web port. */
export function webAddress(apiAddr: string | null | undefined, webPort: number): string | null {
  if (!apiAddr) return null;
  try {
    const u = new URL(/^https?:\/\//.test(apiAddr) ? apiAddr : `http://${apiAddr}`);
    return `http://${u.hostname.includes(':') ? `[${u.hostname}]` : u.hostname}:${webPort}`;
  } catch {
    return null;
  }
}

export async function health(web: string | null): Promise<{ healthy: boolean; commit: string | null; channel: string | null; apiLevel: number | null }> {
  if (!web) return { healthy: false, commit: null, channel: null, apiLevel: null };
  try {
    const r = await fetch(`${web}/api/health`, { signal: AbortSignal.timeout(5000), cache: 'no-store' });
    const j = await r.json().catch(() => null) as { status?: string; version?: { commit?: string; channel?: string }; widget_api_level?: unknown } | null;
    return {
      healthy: r.ok && (j?.status === 'ok' || j?.status === 'degraded'),
      commit: j?.version?.commit ?? null,
      channel: j?.version?.channel ?? null,
      apiLevel: typeof j?.widget_api_level === 'number' && Number.isFinite(j.widget_api_level) ? j.widget_api_level : null,
    };
  } catch {
    return { healthy: false, commit: null, channel: null, apiLevel: null };
  }
}

export async function listNodes(webPort: number): Promise<NodeStatus[]> {
  const nodes = await rqlite.getNodes();
  const recs = await records();
  const me = nodeName();
  return Promise.all(nodes.filter(n => n.voter).sort((a, b) => a.id.localeCompare(b.id)).map(async n => {
    const self = n.id === me;
    const web = webAddress(n.api_addr, webPort);
    const h = self
      ? { healthy: true, commit: bosunVersion().commit, channel: bosunVersion().channel, apiLevel: WIDGET_API_LEVEL }
      : await health(web);
    return { id: n.id, leader: n.leader, reachable: n.reachable, web, ...h, record: recs.get(n.id.replace(/[^A-Za-z0-9_.-]/g, '_')) ?? null, self };
  }));
}
