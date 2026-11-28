/**
 * Self-update: move every Bosun node to the newest published image of a channel (a branch), one node at a time.
 *
 * Images come from the image workflow (ghcr.io/<owner>/bosun:<branch>, :sha-<commit>). Each node's Bosun stack must be a
 * Bosun stack (imported, so its compose files are stored on the host): the widget that declares `stacks.retag` pulls the
 * image on that host, tags it as the image the Bosun service runs (bosun:latest, say) and re-creates that service in the
 * background, without rewriting the compose file. Before anything changes the database is backed up into the data volume.
 * Nodes are updated one at a time, each waited for until it answers on the new commit and is back in the cluster; this node
 * goes last (it restarts itself), and when it comes back on the new commit it closes the record and reports in the bell.
 * A rollback is the same flow to the commit the last finished rollout came from, using its published `sha-<7>` image.
 */
import fs from 'fs';
import path from 'path';
import type { TokenPayload } from '@/lib/auth/jwt';
import { rqlite } from '@/lib/db/rqlite-client';
import { getConfig, setConfig } from '@/lib/db/migrations';
import { logAudit } from '@/lib/audit/logger';
import { notify } from '@/lib/notifications/store';
import { nodeName } from '@/lib/network/node-host';
import { stackManager } from '@/lib/portainer/import';
import { loadDataset, loadRuntimeData } from '@/lib/widgets/runtime/execute';
import { runWidgetAction } from '@/lib/widgets/runtime/run-action';
import { imageRevision } from './registry';
import { health, listNodes, configuredWebPort, type NodeStatus } from './nodes';
import { bosunVersion, commitTag } from './version';
import { UpdateError } from './errors';
import { previousCommit, rollbackImageProblem, rollbackTarget, rolloutRunning, sameCommit, usableCommit, type RolloutKind } from './rollback';

export { UpdateError } from './errors';
export type { RolloutKind } from './rollback';

export interface UpdateConfig { image: string; channel: string; webPort: number }
export interface Latest { commit: string | null; checked_at: string; error: string | null }
export interface PlanStep {
  node: string; self: boolean; server_id: string | null; project: string | null; service: string | null; as: string | null;
  status: 'pending' | 'running' | 'restarting' | 'done' | 'failed' | 'skipped'; message: string | null;
  /** The commit this node ran before the rollout (null when it did not say). */
  from: string | null;
}
export interface Rollout {
  id: string; kind: RolloutKind; target: string; from: string | null; image: string; started_by: string; started_at: string;
  finished_at: string | null; status: 'running' | 'done' | 'failed'; backup: string | null; steps: PlanStep[];
}

const IMAGE_RE = /^[a-z0-9.-]+\.[a-z]{2,}(:\d+)?\/[a-z0-9._/-]+$/;
const CHANNEL_RE = /^[A-Za-z0-9._-]{1,60}$/;

export async function getUpdateConfig(): Promise<UpdateConfig> {
  const [image, channel, webPort] = await Promise.all([getConfig('update.image'), getConfig('update.channel'), configuredWebPort()]);
  const own = bosunVersion().channel;
  return {
    image: image && IMAGE_RE.test(image) ? image : 'ghcr.io/reallango/bosun',
    channel: channel && CHANNEL_RE.test(channel) ? channel : (own !== 'local' && CHANNEL_RE.test(own) ? own : 'main'),
    webPort,
  };
}

export async function setUpdateConfig(c: Partial<UpdateConfig>): Promise<UpdateConfig> {
  if (c.image !== undefined) { if (!IMAGE_RE.test(c.image)) throw new UpdateError('image must look like ghcr.io/owner/bosun', 400, 'VALIDATION'); await setConfig('update.image', c.image); }
  if (c.channel !== undefined) { if (!CHANNEL_RE.test(c.channel)) throw new UpdateError('channel must be a branch name such as main or dev', 400, 'VALIDATION'); await setConfig('update.channel', c.channel); }
  if (c.webPort !== undefined) { if (!(Number.isInteger(c.webPort) && c.webPort > 0 && c.webPort < 65536)) throw new UpdateError('web port must be 1-65535', 400, 'VALIDATION'); await setConfig('update.web_port', String(c.webPort)); }
  return getUpdateConfig();
}

async function readJson<T>(key: string): Promise<T | null> {
  const v = await getConfig(key);
  if (!v) return null;
  try { return JSON.parse(v) as T; } catch { return null; }
}
const writeJson = (key: string, v: unknown) => setConfig(key, JSON.stringify(v));

export async function getRollout(): Promise<Rollout | null> {
  const r = await readJson<Rollout>('update.rollout');
  if (!r) return null;
  return {
    ...r,
    kind: r.kind === 'rollback' ? 'rollback' : 'update',
    from: usableCommit(r.from),
    steps: Array.isArray(r.steps) ? r.steps.map(s => ({ ...s, from: usableCommit(s.from) })) : [],
  };
}
const saveRollout = (r: Rollout) => writeJson('update.rollout', r);

/** Ask the registry which commit the channel's image is, remember it, and announce it when a node runs something else. */
export async function checkForUpdate(): Promise<Latest> {
  const cfg = await getUpdateConfig();
  let latest: Latest;
  try {
    const r = await imageRevision(cfg.image, cfg.channel);
    latest = { commit: r.commit, checked_at: new Date().toISOString(), error: r.commit ? null : `no image for "${cfg.channel}" yet (the image workflow publishes main and dev)` };
  } catch (e) {
    latest = { commit: null, checked_at: new Date().toISOString(), error: e instanceof Error ? e.message : String(e) };
  }
  await writeJson('update.latest', latest);
  if (latest.commit) {
    const nodes = await listNodes(cfg.webPort).catch(() => [] as NodeStatus[]);
    const behind = nodes.filter(n => n.commit && !sameCommit(n.commit, latest.commit));
    if (behind.length) {
      await notify({
        kind: 'bosun_update', severity: 'info', title: `Bosun update available: ${latest.commit.slice(0, 7)} (${cfg.channel})`,
        message: `${behind.map(n => `${n.id} runs ${n.commit?.slice(0, 7) ?? 'an unknown build'}`).join(', ')}. Update from Settings → Updates.`,
        link: '/settings/updates', dedupeKey: `bosun-update:${latest.commit.slice(0, 12)}`, audience: 'admin',
      });
    }
  }
  return latest;
}

type Row = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v));

/** For each node: where its Bosun runs (server, Bosun stack and service, image name) and what stops an update. */
export async function plan(nodes: NodeStatus[]): Promise<{ steps: PlanStep[]; problems: string[] }> {
  const problems: string[] = [];
  const loaded = await stackManager();
  if (!loaded?.spec.stacks?.retag) return { steps: [], problems: ['No installed widget can move a stack to a new image (the Docker widget does from 1.0.12)'] };
  const f = loaded.spec.stacks.fields;
  const steps: PlanStep[] = [];
  for (const n of nodes) {
    const step: PlanStep = {
      node: n.id, self: n.self, server_id: n.record?.server_id ?? null, project: null, service: null, as: null,
      status: 'pending', message: null, from: usableCommit(n.commit),
    };
    steps.push(step);
    if (!n.reachable || !n.healthy) { problems.push(`${n.id} is not reachable${n.web ? ` at ${n.web}` : ''}`); continue; }
    if (!n.record?.server_id) { problems.push(`${n.id} does not know which server it runs on (add that server, or set it under Settings → Wake-on-LAN)`); continue; }
    const rt = await loadRuntimeData(n.record.server_id, loaded).catch(() => null);
    const rows: Row[] = Array.isArray(rt?.data) ? rt!.data as Row[] : [];
    const cid = n.record.container_id ?? '';
    const row = rows.find(r => { const id = str(r[f.id]); return !!id && !!cid && (id.startsWith(cid.slice(0, 12)) || cid.startsWith(id.slice(0, 12))); });
    if (!row) { problems.push(`${n.id}: its container was not found on its server (wait for the next poll)`); continue; }
    step.project = str(row[f.project]) || null;
    step.service = str(row[f.service]) || null;
    step.as = str(row.image) || null;
    if (!step.project || !step.service || !step.as) { problems.push(`${n.id}: its container is not part of a Compose stack`); continue; }
    const listed = await loadDataset(n.record.server_id, loaded, loaded.spec.stacks.list, {}).catch(() => null);
    const stack = (Array.isArray(listed?.data) ? listed!.data as Row[] : []).find(s => str(s.name) === step.project);
    if (!stack || str(stack.source) === 'external') {
      problems.push(`${n.id}: its stack "${step.project}" is not a Bosun stack yet: import it (Settings → Servers → its server → Import stacks, from another node's address)`);
    }
  }
  return { steps, problems };
}

/** Back up the database into the data volume (keeps the last 3). */
async function backup(target: string): Promise<string> {
  const dir = path.join(process.env.RQLITE_DATA_DIR || '/data/rqlite', 'backups');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `pre-update-${new Date().toISOString().replace(/[:.]/g, '-')}-${target.slice(0, 7)}.sqlite`);
  fs.writeFileSync(file, Buffer.from(await rqlite.backup()), { mode: 0o600 });
  const old = fs.readdirSync(dir).filter(n => n.startsWith('pre-update-')).sort();
  for (const n of old.slice(0, Math.max(0, old.length - 3))) fs.rmSync(path.join(dir, n), { force: true });
  return file;
}

export async function updateStatus() {
  const config = await getUpdateConfig();
  const nodes = await listNodes(config.webPort);
  const latest = await readJson<Latest>('update.latest');
  const { steps, problems } = await plan(nodes);
  const rollout = await getRollout();
  return { config, running: bosunVersion(), latest, nodes, plan: steps, problems, rollout, previous: previousCommit(rollout) };
}

/** Nodes that already run `target` are left alone. */
function markSkipped(steps: PlanStep[], nodes: NodeStatus[], target: string): void {
  for (const s of steps) {
    const n = nodes.find(x => x.id === s.node);
    if (sameCommit(n?.commit, target)) { s.status = 'skipped'; s.message = 'already on this version'; }
  }
}

interface Launch { target: string; kind: RolloutKind; from: string | null }

/** Back up, record the rollout, and start moving the nodes. Returns at once; progress is in the record and the bell. */
async function launch(auth: TokenPayload, l: Launch, cfg: UpdateConfig, steps: PlanStep[], ip?: string): Promise<Rollout> {
  const rollout: Rollout = {
    id: `${Date.now()}`, kind: l.kind, target: l.target, from: l.from, image: `${cfg.image}:${commitTag(l.target)}`,
    started_by: auth.username, started_at: new Date().toISOString(), finished_at: null, status: 'running',
    backup: await backup(l.target), steps: [...steps.filter(s => !s.self), ...steps.filter(s => s.self)],
  };
  await saveRollout(rollout);
  await logAudit({
    userId: auth.userId, action: l.kind === 'rollback' ? 'bosun.rollback_start' : 'bosun.update_start', category: 'update', status: 'success', ipAddress: ip,
    details: JSON.stringify({ target: l.target, from: l.from, image: rollout.image, backup: rollout.backup }).slice(0, 900),
  }).catch(() => undefined);
  void run(auth, rollout, cfg, ip).catch(async err => {
    rollout.status = 'failed'; rollout.finished_at = new Date().toISOString();
    await saveRollout(rollout).catch(() => undefined);
    await notify({ kind: 'alert', severity: 'warning', title: `Bosun ${l.kind === 'rollback' ? 'rollback' : 'update'} stopped`, message: err instanceof Error ? err.message : String(err), audience: 'admin', link: '/settings/updates' });
  });
  return rollout;
}

/** Start a rolling update to the newest image of the channel. Returns at once; progress is in the record and the bell. */
export async function startRollout(auth: TokenPayload, ip?: string): Promise<Rollout> {
  const current = await getRollout();
  if (rolloutRunning(current)) throw new UpdateError('An update is already running', 409, 'UPDATE_RUNNING');
  const cfg = await getUpdateConfig();
  const latest = await checkForUpdate();
  if (!latest.commit) throw new UpdateError(`No image to update to: ${latest.error ?? 'unknown'}`);
  const nodes = await listNodes(cfg.webPort);
  const { steps, problems } = await plan(nodes);
  if (problems.length) throw new UpdateError(`Not ready: ${problems.join('; ')}`);
  markSkipped(steps, nodes, latest.commit);
  if (steps.every(s => s.status === 'skipped')) throw new UpdateError('Every node already runs this version', 409, 'UP_TO_DATE');
  return launch(auth, { target: latest.commit, kind: 'update', from: usableCommit(nodes.find(n => n.self)?.commit) }, cfg, steps, ip);
}

/**
 * Start a rolling update to the commit the last finished rollout came from (its published `sha-<7>` image). Same
 * safety as an update: nothing may be running, the previous commit must be known and its image must still exist, and
 * the database is backed up first. The backup is not restored.
 */
export async function startRollback(auth: TokenPayload, ip?: string): Promise<Rollout> {
  const current = await getRollout();
  const cfg = await getUpdateConfig();
  const choice = rollbackTarget(current, cfg.image);
  let rev: { commit: string | null; digest: string | null };
  try {
    rev = await imageRevision(cfg.image, commitTag(choice.target));
  } catch (e) {
    throw new UpdateError(`Could not check the registry for ${choice.image}: ${e instanceof Error ? e.message : String(e)}`, 409, 'NO_IMAGE');
  }
  const missing = rollbackImageProblem(rev, choice.target, choice.image);
  if (missing) throw new UpdateError(missing, 409, 'NO_IMAGE');
  const nodes = await listNodes(cfg.webPort);
  const { steps, problems } = await plan(nodes);
  if (problems.length) throw new UpdateError(`Not ready: ${problems.join('; ')}`);
  markSkipped(steps, nodes, choice.target);
  if (steps.every(s => s.status === 'skipped')) throw new UpdateError('Every node already runs this version', 409, 'UP_TO_DATE');
  return launch(auth, { target: choice.target, kind: 'rollback', from: usableCommit(nodes.find(n => n.self)?.commit) }, cfg, steps, ip);
}

async function retag(auth: TokenPayload, step: PlanStep, image: string, ip?: string): Promise<void> {
  const loaded = await stackManager();
  const action = loaded?.spec.actions.find(a => a.id === loaded.spec.stacks?.retag);
  if (!loaded || !action) throw new Error('The widget that moves stacks to a new image is gone');
  const res = await runWidgetAction(auth, step.server_id!, loaded, action, { params: { name: step.project, service: step.service, image, as: step.as }, confirm: true }, { ip });
  const json = await res.json().catch(() => null) as { data?: { success?: boolean; message?: string; output?: string }; error?: { message?: string } } | null;
  if (res.status >= 400 || json?.data?.success === false) throw new Error(json?.error?.message || json?.data?.message || `HTTP ${res.status}`);
}

async function run(auth: TokenPayload, r: Rollout, cfg: UpdateConfig, ip?: string): Promise<void> {
  for (const step of r.steps) {
    if (step.status === 'skipped') continue;
    step.status = step.self ? 'restarting' : 'running';
    await saveRollout(r);
    if (step.self) {
      // This node last: it is about to restart itself. The new process closes the record (finishRolloutOnStart).
      await retag(auth, step, r.image, ip);
      return;
    }
    await retag(auth, step, r.image, ip);
    const node = (await listNodes(cfg.webPort)).find(n => n.id === step.node);
    const until = Date.now() + 10 * 60_000;
    let ok = false;
    await new Promise(res => setTimeout(res, 15_000));
    while (Date.now() < until) {
      const h = await health(node?.web ?? null);
      const back = (await rqlite.getNodes().catch(() => [])).find(n => n.id === step.node)?.reachable;
      if (h.healthy && back && sameCommit(h.commit, r.target)) { ok = true; break; }
      await new Promise(res => setTimeout(res, 5000));
    }
    if (!ok) {
      step.status = 'failed'; step.message = 'did not come back on the new version within 10 minutes';
      r.status = 'failed'; r.finished_at = new Date().toISOString();
      await saveRollout(r);
      await notify({ kind: 'alert', severity: 'critical', title: `Bosun ${r.kind === 'rollback' ? 'rollback' : 'update'} stopped at ${step.node}`, message: `${step.node} did not come back on ${r.target.slice(0, 7)} within 10 minutes. The other nodes were not touched. Database backup: ${r.backup}`, audience: 'admin', link: '/settings/updates' });
      return;
    }
    step.status = 'done'; step.message = null;
    await saveRollout(r);
  }
  await finish(r);
}

async function finish(r: Rollout): Promise<void> {
  r.status = 'done'; r.finished_at = new Date().toISOString();
  await saveRollout(r);
  const verb = r.kind === 'rollback' ? 'rolled back to' : 'updated to';
  await notify({ kind: 'bosun_update', severity: 'success', title: `Bosun ${verb} ${r.target.slice(0, 7)}`, message: `Every node now runs ${r.image} (started by ${r.started_by}).`, audience: 'admin', link: '/settings/updates', dedupeKey: `bosun-updated:${r.id}` });
  // Every node can now run the packages the new build ships: install the bundled versions that were deferred while
  // the cluster was mixed (see lib/widgets/bundled-seed.ts). The leader's timer retries if this node cannot write.
  await import('@/lib/widgets/bundled-seed')
    .then(m => m.retryDeferredBundledPackages())
    .catch(err => console.warn('[widgets] deferred packages after the rollout:', err instanceof Error ? err.message : err));
}

/** On startup: if this node was the last step of a running update and now runs the target, close the record. */
export async function finishRolloutOnStart(): Promise<void> {
  const r = await getRollout();
  if (!r || r.status !== 'running') return;
  const me = nodeName();
  const step = r.steps.find(s => s.node === me && s.status === 'restarting');
  if (!step) {
    if (Date.now() - Date.parse(r.started_at) > 2 * 60 * 60_000) { r.status = 'failed'; r.finished_at = new Date().toISOString(); await saveRollout(r); }
    return;
  }
  if (sameCommit(bosunVersion().commit, r.target)) {
    step.status = 'done';
    await finish(r);
  }
}

/** Background: remember where this node runs, close a finished update, and check for updates every 6 hours (leader only). */
export function startUpdateTasks(): void {
  const g = globalThis as unknown as { __bosunUpdateTimer?: NodeJS.Timeout };
  if (g.__bosunUpdateTimer || process.env.BOSUN_UPDATE_CHECK === '0') return;
  const tick = async () => {
    try {
      const { recordSelf } = await import('./nodes');
      await recordSelf();
      await finishRolloutOnStart();
      const { advanceSelfImport } = await import('@/lib/portainer/self-import');
      await advanceSelfImport().catch(err => console.warn('[import] own stack:', err instanceof Error ? err.message : err));
      const status = await rqlite.getStatus().catch(() => null) as { store?: { raft?: { state?: string } } } | null;
      if (status?.store?.raft?.state === 'Leader') {
        const last = await readJson<Latest>('update.latest');
        if (!last || Date.now() - Date.parse(last.checked_at) > 6 * 3600_000) await checkForUpdate();
      }
    } catch (err) {
      console.warn('[update] background check failed:', err instanceof Error ? err.message : err);
    }
  };
  setTimeout(tick, 60_000);
  g.__bosunUpdateTimer = setInterval(tick, 30 * 60_000);
}
