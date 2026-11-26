/**
 * Deploy Bosun to a server Bosun already manages: a fresh Linux host is added, Docker is installed ("Set up this server"),
 * and from here Bosun puts itself on it.
 *
 * The compose file is written here (the published image of the configured update channel) and deployed as the stack
 * "bosun" through whichever installed widget manages Compose stacks (`stacks.deploy`), so the new Bosun runs from a Bosun
 * stack from the start and can update itself. Then, in the default mode, it joins this cluster: a one-time join code is
 * made and redeemed for it through the new node's setup API (exactly what an admin does on its setup page). Standalone,
 * it is left at its first-run page, where its own admin account is created.
 *
 * It runs in the background; the record (`deploy.bosun.<serverId>` in app_config) holds its progress, and the outcome
 * goes to the bell.
 */
import type { TokenPayload } from '@/lib/auth/jwt';
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';
import { getConfig } from '@/lib/db/migrations';
import { logAudit } from '@/lib/audit/logger';
import { notify } from '@/lib/notifications/store';
import * as clusterConfig from '@/lib/cluster/config';
import { createJoinCode } from '@/lib/cluster/control';
import { getUpdateConfig } from '@/lib/update/rollout';
import { getJob } from '@/lib/widgets/jobs/store';
import { loadDataset, loadRuntimeData } from '@/lib/widgets/runtime/execute';
import { runWidgetAction } from '@/lib/widgets/runtime/run-action';
import { stackManager } from '@/lib/portainer/import';
import { nodeName } from '@/lib/network/node-host';
import { records, webAddress } from '@/lib/update/nodes';

export type DeployMode = 'join' | 'standalone';

export interface BosunDeploy {
  server_id: string;
  mode: DeployMode;
  node_name: string;
  image: string;
  web: string;
  status: 'running' | 'done' | 'failed';
  step: string;
  message: string | null;
  started_by: string;
  started_at: string;
  finished_at: string | null;
}

export class DeployError extends Error {
  constructor(message: string, readonly status = 409, readonly code = 'DEPLOY_NOT_READY') { super(message); }
}

const STACK = 'bosun';
const key = (serverId: string) => `deploy.bosun.${serverId}`;

/** The compose file of a Bosun node (published image; ports 4001/4002 only for a cluster member). */
export function bosunCompose(o: { image: string; webPort: number; join: boolean }): string {
  const ports = [`      - "${o.webPort}:3042"`, ...(o.join ? ['      - "4001:4001"', '      - "4002:4002"'] : [])];
  return [
    '# Deployed by Bosun. Updated by Bosun\'s self-update (Settings > Updates); data lives in the volume bosun-data.',
    'services:',
    '  bosun:',
    `    image: ${o.image}`,
    '    container_name: bosun',
    '    restart: unless-stopped',
    '    environment:',
    '      - COOKIE_SECURE=false',
    '      - WS_PORT=3002',
    '    volumes:',
    '      - bosun-data:/data/rqlite',
    '    ports:',
    ...ports,
    'volumes:',
    '  bosun-data:',
    '    driver: local',
    '',
  ].join('\n');
}

/** A node name from the server's name: letters, digits, dot, dash and underscore. */
export function nodeNameFrom(name: string): string {
  const n = name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '').slice(0, 40);
  return n || 'node';
}

export async function getDeploy(serverId: string): Promise<BosunDeploy | null> {
  const v = await getConfig(key(serverId)).catch(() => null);
  if (!v) return null;
  try { return JSON.parse(v) as BosunDeploy; } catch { return null; }
}

/** Whether, and how, Bosun already runs on a server. */
export type BosunRunning =
  | { kind: 'node'; node: string; self: boolean; web: string | null }
  | { kind: 'stack'; name: string };

export interface BosunRunningCheck {
  running: BosunRunning | null;
  /** Set when the server could not be asked (no Docker, offline, ...): there is no answer either way. */
  check_error: string | null;
}

type Row = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const short = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);
/** The key node records use in app_config. */
const nodeKey = (node: string) => node.replace(/[^A-Za-z0-9_.-]/g, '_');

/** Is this container image the configured update image (any tag) or the local image `bosun:*`? */
export function isBosunImage(image: string, configured: string): boolean {
  const ref = image.trim().split('@')[0];
  if (!ref) return false;
  const slash = ref.lastIndexOf('/');
  const colon = ref.lastIndexOf(':');
  const repo = colon > slash ? ref.slice(0, colon) : ref;
  return repo === 'bosun' || (!!configured && repo === configured.replace(/\/+$/, ''));
}

/** The node of this cluster that records this server, with its web address when it can be worked out. */
async function nodeOnServer(serverId: string): Promise<{ node: string; self: boolean; web: string | null } | null> {
  const recs = await records();
  const me = nodeKey(nodeName());
  for (const [node, rec] of Array.from(recs)) {
    if (rec.server_id !== serverId) continue;
    let web: string | null = null;
    try {
      const cfg = await getUpdateConfig();
      const n = (await rqlite.getNodes()).find(x => x.id === node || nodeKey(x.id) === node);
      web = webAddress(n?.api_addr ?? n?.addr, cfg.webPort);
    } catch { /* the address is optional */ }
    return { node, self: node === me, web };
  }
  return null;
}

/**
 * Does Bosun already run on this server? A node of this cluster wins (it records its server in `update.node.<node>`);
 * otherwise a stack called "bosun" or a container running a Bosun image (the stack-managing widget's data). When the
 * server cannot be asked, `running` is null and `check_error` says why.
 */
export async function detectBosunRunning(serverId: string): Promise<BosunRunningCheck> {
  let node: Awaited<ReturnType<typeof nodeOnServer>>;
  try { node = await nodeOnServer(serverId); } catch (e) { return { running: null, check_error: short(e) }; }
  if (node) return { running: { kind: 'node', ...node }, check_error: null };

  let loaded: Awaited<ReturnType<typeof stackManager>>;
  try { loaded = await stackManager(); } catch (e) { return { running: null, check_error: short(e) }; }
  if (!loaded?.spec.stacks) return { running: null, check_error: 'No installed widget manages Compose stacks (install one under Settings > Widgets)' };
  const s = loaded.spec.stacks;

  let stacks: Row[];
  try {
    const r = await loadDataset(serverId, loaded, s.list, {});
    stacks = Array.isArray(r.data) ? r.data as Row[] : [];
  } catch (e) {
    return { running: null, check_error: short(e) };
  }
  if (stacks.some(x => str(x.name) === STACK)) return { running: { kind: 'stack', name: STACK }, check_error: null };

  let rows: Row[];
  try {
    const rt = await loadRuntimeData(serverId, loaded, true);
    rows = Array.isArray(rt?.data) ? rt.data as Row[] : [];
  } catch (e) {
    return { running: null, check_error: short(e) };
  }
  const cfg = await getUpdateConfig().catch(() => ({ image: '', webPort: 3042 }));
  const c = rows.find(r => isBosunImage(str(r.image), cfg.image));
  if (c) return { running: { kind: 'stack', name: str(c[s.fields.project]) || str(c[s.fields.name]) || STACK }, check_error: null };
  return { running: null, check_error: null };
}

async function save(d: BosunDeploy): Promise<void> {
  await rqlite.execute(
    `INSERT INTO app_config (key, value, description, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
    [key(d.server_id), JSON.stringify(d), 'Deploying Bosun to this server']);
}

async function waitForJob(jobId: string, timeoutMs: number): Promise<{ status: string; message: string | null }> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const j = await getJob(jobId);
    if (j && j.status !== 'running') return { status: j.status, message: j.message };
    await new Promise(r => setTimeout(r, 3000));
  }
  return { status: 'error', message: 'timed out waiting for the deployment' };
}

async function healthy(web: string): Promise<boolean> {
  try {
    const r = await fetch(`${web}/api/health`, { signal: AbortSignal.timeout(5000), cache: 'no-store' });
    return r.ok;
  } catch {
    return false;
  }
}

/** Check everything that can be known before starting, and start; the rest runs in the background. */
export async function startBosunDeploy(auth: TokenPayload, serverId: string, opts: { mode: DeployMode; nodeName?: string }, ip?: string): Promise<BosunDeploy> {
  const srv = rowsToObjects(await rqlite.query('SELECT id, name, hostname, platform FROM servers WHERE id = ?', [serverId]))[0];
  if (!srv) throw new DeployError('Server not found', 404, 'NOT_FOUND');
  if (String(srv.platform ?? 'linux') !== 'linux') throw new DeployError('Bosun runs on Linux servers only');
  const host = String(srv.hostname);
  if (!clusterConfig.isValidHost(host) || host === 'localhost' || host.startsWith('127.')) throw new DeployError('The server\'s address must be one the other machines reach (LAN IP or DNS name)', 400, 'VALIDATION');
  const prev = await getDeploy(serverId);
  if (prev?.status === 'running' && Date.now() - Date.parse(prev.started_at) < 60 * 60_000) throw new DeployError('Bosun is already being deployed to this server');
  const node = await nodeOnServer(serverId);
  if (node) throw new DeployError(`This server already runs Bosun: it is node ${node.node} of this cluster`);

  const loaded = await stackManager();
  if (!loaded?.spec.stacks) throw new DeployError('No installed widget manages Compose stacks (install one that does, under Settings > Widgets)');
  const deployAction = loaded.spec.actions.find(a => a.id === loaded.spec.stacks!.deploy);
  if (!deployAction) throw new DeployError('The stack widget has no deploy action');
  let stacks: Record<string, unknown>[];
  try {
    const r = await loadDataset(serverId, loaded, loaded.spec.stacks.list, {});
    stacks = Array.isArray(r.data) ? r.data as Record<string, unknown>[] : [];
  } catch (e) {
    throw new DeployError(`Docker is not ready on this server (install it under "Set up this server"): ${e instanceof Error ? e.message : e}`.slice(0, 400));
  }
  if (stacks.some(x => x.name === STACK)) throw new DeployError(`This server already runs Bosun: stack ${STACK}`);

  const cfg = await getUpdateConfig();
  const containers = await loadRuntimeData(serverId, loaded, true).catch(() => null);
  const onImage = (Array.isArray(containers?.data) ? containers!.data as Row[] : []).find(r => isBosunImage(str(r.image), cfg.image));
  if (onImage) throw new DeployError(`This server already runs Bosun: stack ${str(onImage[loaded.spec.stacks.fields.project]) || str(onImage[loaded.spec.stacks.fields.name]) || STACK}`);

  const mode: DeployMode = opts.mode === 'standalone' ? 'standalone' : 'join';
  const nodeName = (opts.nodeName?.trim() || nodeNameFrom(String(srv.name))).toLowerCase();
  if (!clusterConfig.isValidNodeId(nodeName)) throw new DeployError('Node name: letters, digits, dot, dash and underscore', 400, 'VALIDATION');
  if (mode === 'join') {
    if (!clusterConfig.effectiveClusterConfig().cluster_ready) throw new DeployError('This Bosun is not a cluster yet: enable clustering (Settings > Cluster) or deploy a standalone Bosun');
    const nodes = await rqlite.getNodes();
    if (nodes.some(n => n.id === nodeName)) throw new DeployError(`The cluster already has a node called "${nodeName}"`);
    if (nodes.some(n => (n.addr ?? '').split(':')[0] === host)) throw new DeployError('That server is already a member of this cluster');
  }

  const d: BosunDeploy = {
    server_id: serverId, mode, node_name: nodeName, image: `${cfg.image}:${cfg.channel}`,
    web: `http://${host.includes(':') ? `[${host}]` : host}:${cfg.webPort}`,
    status: 'running', step: 'Deploying the stack (pulling the image)', message: null,
    started_by: auth.username, started_at: new Date().toISOString(), finished_at: null,
  };
  await save(d);
  await logAudit({ userId: auth.userId, serverId, action: 'bosun.deploy', category: 'stacks', status: 'success', ipAddress: ip, details: JSON.stringify({ mode, node: nodeName, image: d.image }) }).catch(() => undefined);

  const res = await runWidgetAction(auth, serverId, loaded, deployAction, {
    params: { name: STACK, source: 'editor', yaml: bosunCompose({ image: d.image, webPort: cfg.webPort, join: mode === 'join' }), env: '', repo: '-', branch: '-', file: '-', pull: true, override: '' },
    confirm: true,
  }, { ip });
  const json = await res.json().catch(() => null) as { data?: { jobId?: string; success?: boolean; message?: string }; error?: { message?: string } } | null;
  if (res.status >= 400) {
    await finish(d, false, json?.error?.message || `The deployment was refused (HTTP ${res.status})`);
    throw new DeployError(d.message!, res.status === 403 ? 403 : 502, 'DEPLOY_FAILED');
  }
  void run(d, json?.data?.jobId ?? null, json?.data?.success !== false).catch(async err => {
    await finish(d, false, err instanceof Error ? err.message : String(err));
  });
  return d;
}

async function step(d: BosunDeploy, text: string): Promise<void> { d.step = text; await save(d); }

async function finish(d: BosunDeploy, ok: boolean, message: string): Promise<void> {
  d.status = ok ? 'done' : 'failed';
  d.message = message.slice(0, 1000);
  d.finished_at = new Date().toISOString();
  await save(d);
  await notify({
    kind: 'alert', severity: ok ? 'success' : 'warning', serverId: d.server_id, audience: 'admin',
    title: ok ? (d.mode === 'join' ? `Bosun node ${d.node_name} joined the cluster` : 'Bosun is running on the new server') : 'Deploying Bosun failed',
    message: d.message, link: `/settings/servers/${d.server_id}`,
  });
}

async function run(d: BosunDeploy, jobId: string | null, okSoFar: boolean): Promise<void> {
  const deployed = jobId ? await waitForJob(jobId, 30 * 60_000) : { status: okSoFar ? 'success' : 'error', message: null };
  if (deployed.status !== 'success') return finish(d, false, `The stack did not deploy: ${deployed.message ?? 'unknown error'}`);

  await step(d, 'Waiting for the new Bosun to start');
  const until = Date.now() + 5 * 60_000;
  while (!(await healthy(d.web))) {
    if (Date.now() > until) return finish(d, false, `The stack runs, but ${d.web} did not answer within 5 minutes (is port ${new URL(d.web).port} free and reachable?)`);
    await new Promise(r => setTimeout(r, 5000));
  }
  if (d.mode === 'standalone') {
    return finish(d, true, `Bosun runs at ${d.web}. Open it to create its admin account; it manages itself (its stack is a Bosun stack, so it can update itself).`);
  }

  await step(d, 'Joining the cluster');
  const appUrl = await getConfig('app.url').catch(() => null);
  const { code } = await createJoinCode([appUrl, process.env.APP_URL].filter((x): x is string => !!x));
  const host = new URL(d.web).hostname.replace(/^\[|\]$/g, '');
  const r = await fetch(`${d.web}/api/setup/join`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(60_000),
    body: JSON.stringify({ code, adv_host: host, node_id: d.node_name }),
  }).catch(e => { throw new Error(`could not reach the new Bosun to join it: ${e instanceof Error ? e.message : e}`); });
  if (!r.ok) {
    const j = await r.json().catch(() => null) as { error?: { message?: string } } | null;
    return finish(d, false, `The new Bosun refused to join: ${j?.error?.message ?? `HTTP ${r.status}`}`);
  }

  await step(d, 'Waiting for the node to catch up');
  const joinUntil = Date.now() + 10 * 60_000;
  for (;;) {
    const n = (await rqlite.getNodes().catch(() => [])).find(x => x.id === d.node_name);
    if (n?.reachable && n.voter) break;
    if (Date.now() > joinUntil) return finish(d, false, `${d.node_name} started joining but is not a reachable member after 10 minutes (ports 4001 and 4002 must be reachable between the nodes)`);
    await new Promise(r2 => setTimeout(r2, 5000));
  }
  return finish(d, true, `${d.node_name} (${d.web}) is a member of the cluster. Its stack is a Bosun stack, so Update all nodes includes it.`);
}
