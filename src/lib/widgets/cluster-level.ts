/**
 * The widget API level the cluster can run.
 *
 * Nodes in a rolling update share one database, so a package version that a newer node installs is read by every
 * node at once. A node whose API level is below the package's `requires.api` cannot use it: its widgets show an
 * error and its MCP tools disappear. Before writing such a version, a caller compares it with the lowest level among
 * the current voter nodes and defers it when one is behind (or cannot be asked). Nodes that left the cluster are not
 * in the voter list, so a removed node does not block forever.
 */
import { WIDGET_API_LEVEL } from '@/lib/widgets/api-level';
import { nodeName } from '@/lib/network/node-host';
import { listNodes, configuredWebPort } from '@/lib/update/nodes';

export interface NodeApiLevel {
  id: string;
  /** null when the node did not answer or runs an old build without `widget_api_level` in /api/health. */
  level: number | null;
}

export interface ClusterApiState {
  /** The current voter nodes. */
  nodes: NodeApiLevel[];
  /** The lowest voter level, or null when a voter's level is unknown. */
  minimum: number | null;
}

/**
 * The lowest level among the given (voter) nodes. Null when one node's level is unknown: it may be behind, and a
 * package it cannot run must not be written. Pure.
 */
export function clusterMinimumLevel(nodes: NodeApiLevel[]): number | null {
  if (!nodes.length) return null;
  let minimum: number | null = null;
  for (const n of nodes) {
    if (n.level === null) return null;
    if (minimum === null || n.level < minimum) minimum = n.level;
  }
  return minimum;
}

/** Nodes that cannot run a package needing `requiresApi`: known to be below it, or unknown. Pure. */
export function nodesBehind(nodes: NodeApiLevel[], requiresApi: number): NodeApiLevel[] {
  if (requiresApi <= 1) return [];
  return nodes.filter(n => n.level === null || n.level < requiresApi);
}

/** Whether every node can run a package needing `requiresApi`. A package without `requires` needs level 1. Pure. */
export function clusterCanRun(requiresApi: number, minimum: number | null): boolean {
  if (requiresApi <= 1) return true;
  return minimum !== null && requiresApi <= minimum;
}

/** The nodes that cannot run it, named the way the admin sees them in the message. Pure. */
export function describeNodesBehind(nodes: NodeApiLevel[]): string {
  return nodes.map(n => (n.level === null ? `${n.id} (level unknown)` : `${n.id} (level ${n.level})`)).join(', ');
}

/** The refusal for a manual install on a mixed cluster. Pure. */
export function clusterLevelProblem(requiresApi: number, nodes: NodeApiLevel[]): string | null {
  const behind = nodesBehind(nodes, requiresApi);
  if (!behind.length) return null;
  return `This package needs widget API level ${requiresApi}, but these cluster nodes cannot run it: ${describeNodesBehind(behind)}. Finish updating the cluster first.`;
}

/** Read every voter node's level from its /api/health. Falls back to this node alone when the cluster list fails. */
export async function clusterApiState(): Promise<ClusterApiState> {
  let nodes: NodeApiLevel[] = [];
  try {
    nodes = (await listNodes(await configuredWebPort())).map(n => ({ id: n.id, level: n.apiLevel }));
  } catch {
    nodes = [];
  }
  if (!nodes.length) nodes = [{ id: nodeName(), level: WIDGET_API_LEVEL }];
  return { nodes, minimum: clusterMinimumLevel(nodes) };
}

/** Why a manual install of a package needing `requiresApi` must be refused now, or null when it may proceed. */
export async function clusterInstallProblem(requiresApi: number): Promise<{ message: string; status: number; code: string } | null> {
  if (requiresApi <= 1) return null;
  const { nodes } = await clusterApiState();
  const message = clusterLevelProblem(requiresApi, nodes);
  return message ? { message, status: 422, code: 'CLUSTER_BEHIND' } : null;
}
