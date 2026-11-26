/**
 * Importing a stack that another tool (Portainer) runs into Bosun, through whichever installed widget declares `stacks`
 * (see StacksSpec): Bosun stores the stack under the same project name, so the running containers and their volumes are
 * recognised, and from then on manages it.
 *
 * The compose file comes from Portainer's API (exact file, variables and git settings) or, without it, is rebuilt from the
 * running containers. Detaching from Portainer is optional: Portainer cannot forget a stack without stopping it ("docker
 * compose down", volumes kept), so Bosun first starts a small waiter on the host that brings the stack straight back from
 * Bosun's copy, then asks Portainer to delete it.
 */
import type { TokenPayload } from '@/lib/auth/jwt';
import { rqlite } from '@/lib/db/rqlite-client';
import { logAudit } from '@/lib/audit/logger';
import { notify } from '@/lib/notifications/store';
import { ownContainerIds } from '@/lib/network/node-host';
import { loadDataset, loadRuntimeData, loadWidgetSpec, type LoadedSpec } from '@/lib/widgets/runtime/execute';
import { runWidgetAction } from '@/lib/widgets/runtime/run-action';
import { getJob } from '@/lib/widgets/jobs/store';
import { deleteStack, getConnection, listStacks, stackFile, type PortainerStack } from './client';
import { advanceSelfImport, beginSelfImport, cancelSelfImport } from './self-import';
import { adaptCopiedCompose, envText, gitSourceOf, mergeComposeExports, STACK_NAME, type DeploySource } from './import-spec';

export class ImportError extends Error {
  constructor(message: string, readonly status = 400, readonly code = 'IMPORT_FAILED') { super(message); }
}

/** The installed widget that manages Compose stacks (declares `stacks`), or null. */
export async function stackManager(): Promise<LoadedSpec | null> {
  const r = await rqlite.query('SELECT type FROM custom_widgets WHERE enabled = 1 AND spec IS NOT NULL ORDER BY type');
  for (const [type] of r.values || []) {
    const loaded = await loadWidgetSpec(String(type));
    if (loaded?.spec.stacks) return loaded;
  }
  return null;
}

export interface ImportCandidate {
  name: string;
  containers: { name: string; service: string; state: string }[];
  running: boolean;
  /** This Bosun's own container is part of it: import it from another node's Bosun. */
  own: boolean;
  portainer: { id: number; endpointId: number; git: { repo: string; branch: string; file: string } | null } | null;
  from: Array<'portainer' | 'containers'>;
  importable: boolean;
  reason: string | null;
}

/** A stack Bosun already manages that Portainer still lists (imported without detaching): it can be detached now. */
export interface DetachCandidate {
  name: string;
  running: boolean;
  /** This Bosun runs in this stack: detach it from another node's Bosun. */
  own: boolean;
  portainer: { id: number; endpointId: number; git: { repo: string; branch: string; file: string } | null };
  detachable: boolean;
  reason: string | null;
}

type Row = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v));

async function containerRows(serverId: string, loaded: LoadedSpec): Promise<Row[]> {
  const rt = await loadRuntimeData(serverId, loaded, true).catch(() => null);
  return Array.isArray(rt?.data) ? (rt!.data as Row[]) : [];
}

function isOwn(rows: Row[], idField: string): boolean {
  const mine = ownContainerIds();
  if (!mine.length) return false;
  return rows.some(r => { const id = str(r[idField]); return !!id && mine.some(m => id.startsWith(m) || m.startsWith(id)); });
}

export async function listCandidates(serverId: string): Promise<{ candidates: ImportCandidate[]; detachable: DetachCandidate[]; portainer: { configured: boolean; error: string | null } }> {
  const loaded = await stackManager();
  if (!loaded?.spec.stacks) throw new ImportError('No installed widget manages Compose stacks', 409, 'NO_STACK_MANAGER');
  const s = loaded.spec.stacks;
  const rows = await containerRows(serverId, loaded);
  const listed = await loadDataset(serverId, loaded, s.list, {}).catch(() => null);
  const stackRows: Row[] = Array.isArray(listed?.data) ? listed!.data as Row[] : [];
  const managed = new Set(stackRows.filter(x => str(x.source) && str(x.source) !== 'external').map(x => str(x.name)));
  const external = new Set(stackRows.filter(x => str(x.source) === 'external').map(x => str(x.name)));

  let pstacks: PortainerStack[] = [];
  let perror: string | null = null;
  const conn = await getConnection(serverId);
  if (conn?.hasKey) {
    try { pstacks = await listStacks(serverId); } catch (e) { perror = e instanceof Error ? e.message : String(e); }
  }
  const byName = new Map(pstacks.map(p => [p.Name, p]));
  const names = new Set<string>([...Array.from(external), ...pstacks.map(p => p.Name)]);
  const out: ImportCandidate[] = [];
  for (const name of Array.from(names).sort()) {
    if (managed.has(name)) continue;
    const mine = rows.filter(r => str(r[s.fields.project]) === name);
    const p = byName.get(name) ?? null;
    const notes: string[] = [];
    const from: ImportCandidate['from'] = [];
    if (p) from.push('portainer');
    if (mine.length && loaded.spec.stacks.export) from.push('containers');
    const own = isOwn(mine, s.fields.id);
    let reason: string | null = null;
    if (!STACK_NAME.test(name)) reason = 'The stack name is not one Bosun can use (lower-case letters, digits, - and _)';
    else if (own && !(s.deployLater || s.deployPrivilegedLater)) reason = 'This Bosun runs in this stack: import it from another node\'s Bosun, or update the stack widget to a version that can start it in the background';
    else if (!from.length) reason = 'Nothing to import from (no Portainer record and no containers)';
    out.push({
      name,
      containers: mine.map(r => ({ name: str(r[s.fields.name]), service: str(r[s.fields.service]), state: str(r[s.fields.state]) })),
      running: mine.some(r => str(r[s.fields.state]) === 'running'),
      own,
      portainer: p ? { id: p.Id, endpointId: p.EndpointId, git: gitSourceOf(p.GitConfig, notes) } : null,
      from,
      importable: !reason,
      reason,
    });
  }
  const detachable: DetachCandidate[] = [];
  for (const name of Array.from(managed).sort()) {
    const p = byName.get(name);
    if (!p) continue;
    const mine = rows.filter(r => str(r[s.fields.project]) === name);
    const own = isOwn(mine, s.fields.id);
    const reason = null; // this node's own stack too: self-import.ts reports the outcome after the restart
    detachable.push({
      name,
      running: mine.some(r => str(r[s.fields.state]) === 'running'),
      own,
      portainer: { id: p.Id, endpointId: p.EndpointId, git: gitSourceOf(p.GitConfig, []) },
      detachable: !reason,
      reason,
    });
  }
  return { candidates: out, detachable, portainer: { configured: !!conn?.hasKey, error: perror } };
}

/** What to deploy for one candidate. */
async function sourceFor(serverId: string, loaded: LoadedSpec, c: ImportCandidate, from: 'portainer' | 'containers'): Promise<DeploySource> {
  const notes: string[] = [];
  if (from === 'portainer') {
    const all = await listStacks(serverId);
    const p = all.find(x => x.Id === c.portainer?.id);
    if (!p) throw new ImportError('Portainer no longer has this stack', 409, 'NOT_FOUND');
    const env = envText(p.Env, notes);
    const git = gitSourceOf(p.GitConfig, notes);
    if (git) return { source: 'git', yaml: '', env, ...git, notes };
    const yaml = adaptCopiedCompose(await stackFile(serverId, p.Id), notes);
    return { source: 'editor', yaml, env, repo: '-', branch: '-', file: '-', notes };
  }
  const exp = loaded.spec.stacks!.export!;
  const parts: { service: string; text: string }[] = [];
  for (const k of c.containers) {
    const r = await loadDataset(serverId, loaded, exp, { name: k.name });
    const d = r.data as { text?: string; error?: string } | string | null;
    const text = typeof d === 'string' ? d : d?.text;
    if (!text) throw new ImportError(`Could not export the container ${k.name}${d && typeof d === 'object' && d.error ? `: ${d.error}` : ''}`, 502);
    parts.push({ service: k.service || k.name, text });
  }
  notes.push('Rebuilt from the running containers: values are written out literally (no ${VARIABLES}) and build contexts are not known');
  return { source: 'editor', yaml: mergeComposeExports(parts, notes), env: '', repo: '-', branch: '-', file: '-', notes };
}

async function waitForJob(jobId: string, timeoutMs = 30 * 60_000): Promise<{ status: string; message: string | null }> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const j = await getJob(jobId);
    if (j && j.status !== 'running') return { status: j.status, message: j.message };
    await new Promise(r => setTimeout(r, 2000));
  }
  return { status: 'error', message: 'timed out waiting for the deployment' };
}

/**
 * Remove a stack Bosun manages from Portainer. Portainer cannot forget a stack without stopping it ("docker compose down",
 * volumes kept), so for a running stack the host waiter (`guard`) is started first: it waits until Portainer has taken the
 * stack down and starts it again from Bosun's copy. Answers a sentence for the bell; never throws.
 */
export async function detachStack(
  auth: TokenPayload, serverId: string, loaded: LoadedSpec, name: string,
  portainer: { id: number; endpointId: number }, running: boolean, ip?: string,
): Promise<string> {
  const s = loaded.spec.stacks!;
  try {
    if (running) {
      const guard = loaded.spec.actions.find(a => a.id === s.guard);
      if (!guard) throw new Error('the stack widget cannot restart a stack after a hand-over');
      const g = await runWidgetAction(auth, serverId, loaded, guard, { params: { name }, confirm: true }, { ip });
      if (g.status >= 400) throw new Error(`could not start the restart guard (HTTP ${g.status})`);
    }
    await deleteStack(serverId, portainer.id, portainer.endpointId);
    return running ? 'It was removed from Portainer and started again from Bosun\'s copy.' : 'It was removed from Portainer.';
  } catch (e) {
    return `Detaching from Portainer failed: ${e instanceof Error ? e.message : String(e)}. The stack is managed by Bosun; Portainer still lists it.`;
  }
}

/**
 * Detach a stack that was imported earlier without detaching (Bosun manages it, Portainer still lists it). Runs in the
 * background; the outcome goes to the bell. Signed-in Full access only (the route checks).
 */
export async function startDetach(auth: TokenPayload, serverId: string, name: string, ip?: string): Promise<{ name: string }> {
  const loaded = await stackManager();
  if (!loaded?.spec.stacks) throw new ImportError('No installed widget manages Compose stacks', 409, 'NO_STACK_MANAGER');
  const { detachable, portainer } = await listCandidates(serverId);
  if (!portainer.configured) throw new ImportError('Connect Portainer for this server first', 400, 'NO_PORTAINER');
  if (portainer.error) throw new ImportError(`Portainer: ${portainer.error}`, 502, 'PORTAINER_ERROR');
  const c = detachable.find(x => x.name === name);
  if (!c) throw new ImportError('Bosun does not manage a stack of that name that Portainer still lists', 404, 'NOT_FOUND');
  if (!c.detachable) throw new ImportError(c.reason || 'This stack cannot be detached here', 409, 'NOT_DETACHABLE');
  if (c.own) {
    // Portainer's delete stops this Bosun: the record lets the restarted process report the outcome (see self-import.ts).
    const started = await beginSelfImport({
      name, serverId, detach: true, portainer: { id: c.portainer.id, endpointId: c.portainer.endpointId }, running: c.running,
      user: { id: String(auth.userId), username: auth.username },
    });
    if (!started) throw new ImportError('An import or detach of this node\'s own stack is already under way', 409, 'IMPORT_BUSY');
  }
  await logAudit({ userId: auth.userId, serverId, action: 'stack.detach', category: 'stacks', status: 'success', ipAddress: ip, details: JSON.stringify({ name, own: c.own, portainer: c.portainer.id }).slice(0, 900) }).catch(() => undefined);

  if (c.own) {
    void advanceSelfImport().catch(err => console.error('[detach] own stack:', err));
    return { name };
  }
  void (async () => {
    const outcome = await detachStack(auth, serverId, loaded, name, c.portainer, c.running, ip);
    const failed = outcome.startsWith('Detaching from Portainer failed');
    await notify({ kind: 'alert', severity: failed ? 'warning' : 'success', title: failed ? `Detaching ${name} failed` : `Detached ${name} from Portainer`, message: `${outcome}`.slice(0, 1900), serverId, audience: 'admin' });
    await logAudit({ userId: auth.userId, serverId, action: 'stack.detach_done', category: 'stacks', status: failed ? 'failure' : 'success', details: `${name}: ${outcome}`.slice(0, 900) }).catch(() => undefined);
  })().catch(err => console.error('[detach] background step failed:', err));

  return { name };
}

export interface ImportStarted { name: string; jobId: string | null; notes: string[] }

/**
 * Store and (re)start one stack in Bosun, then (in the background, reported in the bell) detach it from Portainer when asked.
 * Signed-in Full access only (the route checks); stacks with elevated options are imported as they run (privileged deploy).
 */
export async function startImport(auth: TokenPayload, serverId: string, name: string, from: 'portainer' | 'containers', detach: boolean, ip?: string): Promise<ImportStarted> {
  const loaded = await stackManager();
  if (!loaded?.spec.stacks) throw new ImportError('No installed widget manages Compose stacks', 409, 'NO_STACK_MANAGER');
  const s = loaded.spec.stacks;
  const { candidates } = await listCandidates(serverId);
  const c = candidates.find(x => x.name === name);
  if (!c) throw new ImportError('No such external stack on this server', 404, 'NOT_FOUND');
  if (!c.importable) throw new ImportError(c.reason || 'This stack cannot be imported', 409, 'NOT_IMPORTABLE');
  if (!c.from.includes(from)) throw new ImportError(`This stack cannot be imported from ${from === 'portainer' ? 'Portainer' : 'its containers'}`, 400, 'BAD_SOURCE');
  if (detach && !c.portainer) throw new ImportError('There is no Portainer record to detach from', 400, 'NO_PORTAINER');
  const src = await sourceFor(serverId, loaded, c, from);

  // This Bosun's own stack: the "later" deploy, which starts the stack after answering (re-creating it ends this process).
  const deployId = c.own ? (s.deployPrivilegedLater ?? s.deployLater)! : (s.deployPrivileged ?? s.deploy);
  const action = loaded.spec.actions.find(a => a.id === deployId)!;
  // This Bosun's own stack: the widget starts it after answering (re-creating it ends this process), and the record lets the
  // restarted process finish the import (see self-import.ts).
  if (c.own) {
    const started = await beginSelfImport({
      name, serverId, detach: detach && !!c.portainer, portainer: c.portainer ? { id: c.portainer.id, endpointId: c.portainer.endpointId } : null,
      running: c.running, user: { id: String(auth.userId), username: auth.username },
    });
    if (!started) throw new ImportError('An import of this node\'s own stack is already under way', 409, 'IMPORT_BUSY');
  }
  const res = await runWidgetAction(auth, serverId, loaded, action, {
    params: { name, source: src.source, yaml: src.yaml, env: src.env, repo: src.repo, branch: src.branch, file: src.file, pull: false, override: '' },
    confirm: true,
  }, { ip });
  const json = await res.json().catch(() => null) as { data?: { jobId?: string; success?: boolean; message?: string }; error?: { message?: string } } | null;
  if (res.status >= 400) {
    if (c.own) await cancelSelfImport();
    throw new ImportError(json?.error?.message || `The deployment was refused (HTTP ${res.status})`, res.status === 403 ? 403 : 502);
  }
  const jobId = json?.data?.jobId ?? null;
  await logAudit({ userId: auth.userId, serverId, action: 'stack.import', category: 'stacks', status: 'success', ipAddress: ip, details: JSON.stringify({ name, from, detach, own: c.own, job: jobId }).slice(0, 900) }).catch(() => undefined);

  // The rest waits for the deployment; its outcome goes to the bell.
  void (async () => {
    const outcome = jobId ? await waitForJob(jobId) : { status: json?.data?.success === false ? 'error' : 'success', message: json?.data?.message ?? null };
    if (outcome.status !== 'success') {
      if (c.own) await cancelSelfImport();
      await notify({ kind: 'alert', severity: 'warning', title: `Importing ${name} failed`, message: outcome.message || 'The deployment did not finish', serverId, audience: 'admin' });
      return;
    }
    if (c.own) {
      // The stack restarts in a few seconds, normally ending this process; if it is still here, it finishes the import itself.
      setTimeout(() => { advanceSelfImport().catch(err => console.error('[import] own stack:', err)); }, 20_000);
      return;
    }
    const detached = detach && c.portainer ? ` ${await detachStack(auth, serverId, loaded, name, c.portainer, c.running, ip)}` : '';
    await notify({
      kind: 'alert', severity: detached.includes('failed') ? 'warning' : 'success', title: `Imported ${name} into Bosun`,
      message: `${name} is now a Bosun stack.${detached}${src.notes.length ? ` Notes: ${src.notes.join('; ')}` : ''}`.slice(0, 1900), serverId, audience: 'admin',
    });
    await logAudit({ userId: auth.userId, serverId, action: 'stack.import_done', category: 'stacks', status: detached.includes('failed') ? 'failure' : 'success', details: `${name}:${detached || ' kept in Portainer'}`.slice(0, 900) }).catch(() => undefined);
  })().catch(err => console.error('[import] background step failed:', err));

  return { name, jobId, notes: src.notes };
}
