import fs from 'fs';
import os from 'os';
import { rqlite } from '@/lib/db/rqlite-client';
import { getConfig, setConfig } from '@/lib/db/migrations';
import { effectiveClusterConfig } from '@/lib/cluster/config';
import { runOnServerId } from '@/lib/ssh/connection-pool';

/**
 * Which managed server is this Bosun node's container running on?
 *
 * Wake-on-LAN packets must leave from the target's L2 segment. In a
 * multi-node setup each Bosun node sends them over SSH from the host its own
 * container runs on, which is online by definition (the node is running), not
 * from some fixed server that may be down.
 *
 * Resolution: an explicit mapping for this node (app_config
 * `wol.node_host.<NODE_NAME>`) wins. Otherwise, if this process runs in a Docker container, the host is found by
 * asking each
 * managed Linux server whether its Docker daemon has it (`docker inspect <our id>`). Not in a container: no host.
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

/** Does `docker inspect <short id>` output (the full container id) belong to one of our container ids? Pure (tested). */
export function matchInspectOutput(ids: string[], stdout: string): boolean {
  const full = stdout.trim().split(/\s+/)[0] || '';
  if (!/^[0-9a-f]{64}$/.test(full)) return false;
  return ids.some(id => full.startsWith(id.slice(0, 12)));
}

const g = globalThis as unknown as { __bosunNodeHost?: { at: number; serverId: string | null } };
const FOUND_TTL_MS = 10 * 60 * 1000;
const MISS_TTL_MS = 2 * 60 * 1000;

/**
 * Ask the managed Linux servers which one runs this container: `docker inspect <our container id>` succeeds
 * only on the host whose Docker daemon has it. This does not depend on any widget or on what the poller has
 * stored. The answer is remembered for 10 minutes (2 when nothing was found), since a container rarely moves.
 */
async function pollForHost(ids: string[]): Promise<string | null> {
  const now = Date.now();
  const hit = g.__bosunNodeHost;
  if (hit && now - hit.at < (hit.serverId ? FOUND_TTL_MS : MISS_TTL_MS)) return hit.serverId;

  const short = ids.map(id => id.slice(0, 12)).find(s => /^[0-9a-f]{12}$/.test(s));
  let found: string | null = null;
  if (short) {
    const r = await rqlite.query("SELECT id FROM servers WHERE COALESCE(platform, 'linux') = 'linux' AND ssh_key_id IS NOT NULL ORDER BY name");
    const candidates = (r.values || []).map(v => String(v[0]));
    // A few at a time, so a large fleet is not asked all at once.
    for (let i = 0; i < candidates.length && !found; i += 6) {
      const batch = candidates.slice(i, i + 6);
      const results = await Promise.all(batch.map(async (serverId) => {
        try {
          const out = await runOnServerId(serverId, `docker inspect --format '{{.Id}}' ${short} 2>/dev/null`, { timeoutMs: 8000 });
          return out.exitCode === 0 && matchInspectOutput(ids, out.stdout) ? serverId : null;
        } catch {
          return null;   // offline, no Docker, no permission: not this one
        }
      }));
      found = results.find(Boolean) ?? null;
    }
  }
  g.__bosunNodeHost = { at: now, serverId: found };
  return found;
}

/** Forget the remembered answer (after changing mappings or when asked to look again). */
export function forgetDetectedNodeHost(): void {
  g.__bosunNodeHost = undefined;
}

/**
 * The managed server this Bosun node's container runs on, or null (not in a container, or not found).
 * The managed servers are asked directly (nothing depends on a widget or on what the poller has stored).
 */
export async function detectNodeHost(): Promise<string | null> {
  const ids = ownContainerIds();
  if (!ids.length) return null;   // not running in a container: there is no host to find
  return await pollForHost(ids);
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
