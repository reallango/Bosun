import fs from 'fs';
import os from 'os';
import { rqlite } from '@/lib/db/rqlite-client';
import { getConfig, setConfig } from '@/lib/db/migrations';
import { effectiveClusterConfig } from '@/lib/cluster/config';

/**
 * Which managed server is this Bosun node's container running on?
 *
 * Wake-on-LAN packets must leave from the target's L2 segment. In a
 * multi-node setup each Bosun node sends them over SSH from the host its own
 * container runs on, which is online by definition (the node is running), not
 * from some fixed server that may be down.
 *
 * Resolution: an explicit mapping for this node (app_config
 * `wol.node_host.<NODE_NAME>`) wins; otherwise the host is detected by
 * finding this container's ID among the Docker containers the poller has seen
 * on each managed server.
 */

export function nodeName(): string {
  // The rqlite node id (UI cluster settings over NODE_NAME), so WoL mappings
  // follow the node even when its id was set from the UI.
  return String(effectiveClusterConfig().node_id || os.hostname()).trim();
}

function mappingKey(node = nodeName()): string {
  return `wol.node_host.${node.replace(/[^A-Za-z0-9_.-]/g, '_')}`;
}

/** Docker container IDs this process could be running in (full and short). */
export function ownContainerIds(): string[] {
  const ids = new Set<string>();
  for (const file of ['/proc/self/mountinfo', '/proc/self/cgroup']) {
    try {
      const text = fs.readFileSync(file, 'utf8');
      for (const m of Array.from(text.matchAll(/(?:containers\/|docker[-/])([0-9a-f]{64})/g))) ids.add(m[1]);
    } catch { /* not Linux or not readable */ }
  }
  const host = os.hostname();
  if (/^[0-9a-f]{12}$/.test(host)) ids.add(host);
  return Array.from(ids);
}

/** Pure matcher (tested): which server's docker snapshot contains one of our IDs? */
export function matchContainerHost(
  ids: string[],
  snapshots: { serverId: string; containers: { id?: string }[] }[],
): string | null {
  const shorts = ids.map(id => id.slice(0, 12));
  for (const s of snapshots) {
    if (s.containers.some(c => c.id && shorts.includes(String(c.id).slice(0, 12)))) return s.serverId;
  }
  return null;
}

export async function detectNodeHost(): Promise<string | null> {
  const ids = ownContainerIds();
  if (!ids.length) return null;
  const r = await rqlite.query("SELECT server_id, data FROM host_snapshots WHERE section = 'docker'");
  const snapshots = r.values.map(([serverId, data]) => {
    let containers: { id?: string }[] = [];
    try { containers = JSON.parse(String(data)).containers || []; } catch { containers = []; }
    return { serverId: String(serverId), containers };
  });
  return matchContainerHost(ids, snapshots);
}

export async function getNodeHostMapping(): Promise<string | null> {
  return (await getConfig(mappingKey())) || null;
}

export async function setNodeHostMapping(serverId: string | null): Promise<void> {
  await setConfig(mappingKey(), serverId || '');
}

export type WolSenderMode = 'auto' | 'local_server' | 'container';

export interface WolSender {
  mode: WolSenderMode;
  /** Server to send from over SSH; null = send from the container. */
  serverId: string | null;
  source: 'mapping' | 'detected' | 'local_server' | null;
}

/** Decide where magic packets are sent from, for this node. */
export async function resolveWolSender(): Promise<WolSender> {
  const raw = (await getConfig('wol.sender')) || 'auto';
  const mode: WolSenderMode = raw === 'local_server' || raw === 'container' ? raw : 'auto';
  if (mode === 'container') return { mode, serverId: null, source: null };
  if (mode === 'local_server') {
    const id = await getConfig('wol.local_server_id');
    return { mode, serverId: id || null, source: id ? 'local_server' : null };
  }
  const mapped = await getNodeHostMapping();
  if (mapped) return { mode, serverId: mapped, source: 'mapping' };
  const detected = await detectNodeHost().catch(() => null);
  return { mode, serverId: detected, source: detected ? 'detected' : null };
}
