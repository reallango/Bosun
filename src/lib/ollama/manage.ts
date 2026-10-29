import { rqlite } from '@/lib/db/rqlite-client';
import { runOnServerId } from '@/lib/ssh/connection-pool';
import { logAudit, AuditActions } from '@/lib/audit/logger';
import {
  RESTART_POLICIES, SYSTEMD_STARTUP, WINDOWS_STARTUP, VERSION_RE,
  dockerControlCommand, dockerInstallCommand, dockerUpdateCommand, hostInstallCommand, isNewerVersion, recreateRunCommand,
  systemdCommand, windowsScript, windowsServiceScript,
} from '@/lib/ollama/scripts';

/**
 * Install, update and control Ollama on a monitored host. What to do depends on how it is installed (the poller
 * records that in the `ollama` snapshot section, see lib/collect/ollama-install.js):
 *   Windows  a service run by nssm (the default for a new install), a plain Windows service, or a standard install
 *   Linux    a Docker container (the default for a new install), a systemd service, or a standard install
 * Quick actions run at once; install and update download a lot, so they run as a job the widget polls.
 */

export interface OllamaInstall {
  kind: 'docker' | 'service' | 'standard' | 'none';
  dockerAvailable?: boolean;
  manager?: 'nssm' | 'windows' | 'systemd';
  name?: string;
  container?: string;
  image?: string;
  state?: string;
  restartPolicy?: string;
  startMode?: string;
  exe?: string;
  path?: string;
}

export interface OllamaState {
  platform: 'linux' | 'windows';
  status: string;
  version: string | null;
  install: OllamaInstall | null;
  collectedAt: string | null;
}

export type OllamaAction = 'start' | 'stop' | 'restart' | 'set_startup' | 'set_restart_policy' | 'install' | 'update';

export class OllamaManageError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 400, code = 'OLLAMA_MANAGE') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** What the poller last saw of Ollama on this server. */
export async function loadOllamaState(serverId: string): Promise<OllamaState> {
  const s = await rqlite.query('SELECT platform FROM servers WHERE id = ?', [serverId]);
  if (!s.values?.length) throw new OllamaManageError('Server not found', 404, 'NOT_FOUND');
  const platform = s.values[0][0] === 'windows' ? 'windows' : 'linux';
  const r = await rqlite.query("SELECT data, collected_at FROM host_snapshots WHERE server_id = ? AND section = 'ollama'", [serverId]);
  let data: { status?: string; version?: string | null; install?: OllamaInstall } = {};
  if (r.values?.length) { try { data = JSON.parse(String(r.values[0][0])); } catch { data = {}; } }
  return {
    platform, status: data.status ?? 'unknown', version: data.version ?? null, install: data.install ?? null,
    collectedAt: r.values?.length ? new Date(Number(r.values[0][1])).toISOString() : null,
  };
}

// ---- The latest release ------------------------------------------------------------------------------------

const RELEASE_TTL_MS = 6 * 3600 * 1000;
const gl = globalThis as unknown as { __bosunOllamaLatest?: { at: number; version: string | null } };

/** The newest Ollama release (x.y.z), cached for six hours; null when GitHub cannot be reached. */
export async function latestOllamaVersion(fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const hit = gl.__bosunOllamaLatest;
  if (hit && Date.now() - hit.at < RELEASE_TTL_MS) return hit.version;
  let version: string | null = null;
  try {
    const res = await fetchImpl('https://api.github.com/repos/ollama/ollama/releases/latest', {
      headers: { 'User-Agent': 'bosun', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const tag = String(((await res.json()) as { tag_name?: string }).tag_name ?? '');
      const m = tag.match(/(\d+\.\d+\.\d+)/);
      version = m ? m[1] : null;
    }
  } catch { /* offline: no update information */ }
  gl.__bosunOllamaLatest = { at: Date.now() - (version ? 0 : RELEASE_TTL_MS - 5 * 60 * 1000), version };
  return version;
}

/** What the widget needs to decide which controls to offer. */
export async function describeOllama(serverId: string) {
  const state = await loadOllamaState(serverId);
  const latest = await latestOllamaVersion();
  const kind = state.install?.kind ?? null;
  return {
    ...state,
    latestVersion: latest,
    updateAvailable: !!latest && isNewerVersion(state.version, latest) && (kind === 'docker' || (kind === 'service' && !!state.install?.name)),
    job: currentJob(serverId),
  };
}

// ---- Jobs ---------------------------------------------------------------------------------------------------

export interface ServiceJob {
  id: string;
  serverId: string;
  action: 'install' | 'update';
  status: 'running' | 'success' | 'error';
  startedAt: number;
  finishedAt: number | null;
  steps: string[];
  message: string | null;
}

const gj = globalThis as unknown as { __bosunOllamaJobs?: Map<string, ServiceJob> };
const jobs: Map<string, ServiceJob> = gj.__bosunOllamaJobs ?? (gj.__bosunOllamaJobs = new Map());
const JOB_TIMEOUT_MS = 60 * 60 * 1000;
const KEEP_FINISHED_MS = 15 * 60 * 1000;

export function currentJob(serverId: string): ServiceJob | null {
  const j = jobs.get(serverId);
  if (!j) return null;
  if (j.finishedAt && Date.now() - j.finishedAt > KEEP_FINISHED_MS) { jobs.delete(serverId); return null; }
  return j;
}

function lastLines(text: string, n = 6): string[] {
  return text.split(/\r?\n/).map(l => l.trim()).filter(Boolean).slice(-n);
}

/** The plain reason a script failed: its `ERROR:` line when it printed one, else the last lines of output. */
function failureMessage(stdout: string, stderr: string): string {
  const err = lastLines(stdout, 200).reverse().find(l => l.startsWith('ERROR:'));
  return err ? err.slice('ERROR:'.length).trim() : lastLines(stderr || stdout, 3).join(' ');
}

function startJob(serverId: string, action: 'install' | 'update', command: string, userId: string): ServiceJob {
  const running = currentJob(serverId);
  if (running && running.status === 'running') throw new OllamaManageError('An install or update is already running on this server', 409, 'JOB_RUNNING');
  const job: ServiceJob = {
    id: `${serverId}-${Date.now()}`, serverId, action, status: 'running', startedAt: Date.now(), finishedAt: null, steps: [], message: null,
  };
  jobs.set(serverId, job);
  runOnServerId(serverId, command, { timeoutMs: JOB_TIMEOUT_MS })
    .then(async r => {
      job.steps = r.stdout.split(/\r?\n/).filter(l => l.startsWith('[step]')).map(l => l.replace('[step] ', ''));
      const done = r.stdout.split(/\r?\n/).reverse().find(l => l.startsWith('DONE'));
      if (r.exitCode === 0 && !r.timedOut && done) { job.status = 'success'; job.message = done.replace(/^DONE\s*/, '') || 'done'; }
      else {
        job.status = 'error';
        job.message = (r.timedOut ? 'It took too long and was stopped' : failureMessage(r.stdout, r.stderr)) || `Failed (exit ${r.exitCode})`;
      }
    })
    .catch(err => { job.status = 'error'; job.message = err instanceof Error ? err.message : String(err); })
    .finally(async () => {
      job.finishedAt = Date.now();
      await logAudit({ userId, serverId, action: AuditActions.OLLAMA_SERVICE, status: job.status === 'success' ? 'success' : 'failure',
        details: JSON.stringify({ action, message: job.message }) }).catch(() => undefined);
      await rqlite.execute('UPDATE servers SET poll_requested_at = ? WHERE id = ?', [Date.now(), serverId]).catch(() => undefined);
    });
  return job;
}

// ---- Actions ------------------------------------------------------------------------------------------------

export interface ActionParams {
  value?: unknown;
  /** Linux install: where to install it. Docker by default. */
  method?: unknown;
  /** Install or update a specific release instead of the latest. */
  version?: unknown;
}

export interface ActionResult {
  job?: ServiceJob;
  message?: string;
}

/** Check a requested version: x.y.z, or nothing for the latest. */
function versionParam(v: unknown): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string' || !VERSION_RE.test(v)) throw new OllamaManageError('Invalid version', 400, 'BAD_VERSION');
  return v;
}

async function runQuick(serverId: string, command: string, what: string): Promise<string> {
  const r = await runOnServerId(serverId, command, { timeoutMs: 120_000 });
  if (r.exitCode !== 0 || r.timedOut) {
    const why = (r.timedOut ? 'It timed out' : lastLines(r.stderr || r.stdout, 3).join(' ')) || `exit ${r.exitCode}`;
    throw new OllamaManageError(`${what} failed: ${why}`, 502, 'ACTION_FAILED');
  }
  return lastLines(r.stdout, 2).join(' ');
}

/** Docker image of a container with a new tag (same repository). */
function imageWithTag(image: string, tag: string): string {
  const repo = image.replace(/:[^:/]+$/, '');
  return `${repo || 'ollama/ollama'}:${tag}`;
}

export async function runOllamaAction(serverId: string, userId: string, action: OllamaAction, p: ActionParams = {}): Promise<ActionResult> {
  const state = await loadOllamaState(serverId);
  const inst = state.install;
  const windows = state.platform === 'windows';

  if (action === 'install') {
    if (!inst) throw new OllamaManageError('Bosun has not checked how Ollama is installed on this server yet. Wait for the next poll and try again.', 409, 'UNKNOWN_STATE');
    if (inst.kind !== 'none') throw new OllamaManageError('Ollama is already installed on this server', 409, 'ALREADY_INSTALLED');
    const version = versionParam(p.version);
    if (windows) return { job: startJob(serverId, 'install', windowsScript({ mode: 'install', version }), userId) };
    const method = p.method === 'host' ? 'host' : 'docker';
    if (method === 'docker') {
      if (!inst?.dockerAvailable) throw new OllamaManageError('Docker is not installed (or not usable by the Bosun account) on this server. Install Docker first, or choose to install Ollama on the host.', 409, 'NO_DOCKER');
      return { job: startJob(serverId, 'install', dockerInstallCommand({ version }), userId) };
    }
    return { job: startJob(serverId, 'install', hostInstallCommand(version), userId) };
  }

  if (!inst || inst.kind === 'none') throw new OllamaManageError('Ollama is not installed on this server', 409, 'NOT_INSTALLED');
  if (inst.kind === 'standard') {
    throw new OllamaManageError('This is a standard install, not a service or container, so Bosun cannot control it. Install Ollama as a service (or container) to manage it from here.', 409, 'STANDARD_INSTALL');
  }

  if (action === 'update') {
    const version = versionParam(p.version) ?? (await latestOllamaVersion());
    if (inst.kind === 'docker') {
      if (!inst.container) throw new OllamaManageError('The container could not be identified', 409, 'NO_CONTAINER');
      // The container is recreated from its own settings, so read them first.
      const insp = await runOnServerId(serverId, `docker inspect ${inst.container} 2>/dev/null || sudo -n docker inspect ${inst.container}`, { timeoutMs: 30_000 });
      let parsed: unknown;
      try { parsed = JSON.parse(insp.stdout)[0]; } catch { throw new OllamaManageError('Could not read the container settings', 502, 'INSPECT_FAILED'); }
      const image = imageWithTag(inst.image || 'ollama/ollama', version ?? 'latest');
      let runCmd: string;
      try { runCmd = recreateRunCommand(parsed as Parameters<typeof recreateRunCommand>[0], image, inst.container); }
      catch (e) { throw new OllamaManageError(e instanceof Error ? e.message : String(e), 409, 'CANNOT_RECREATE'); }
      return { job: startJob(serverId, 'update', dockerUpdateCommand(inst.container, image, runCmd), userId) };
    }
    if (windows) {
      if (!inst.name || !inst.exe) throw new OllamaManageError('The service executable could not be found', 409, 'NO_EXE');
      return { job: startJob(serverId, 'update', windowsScript({ mode: 'update', service: inst.name, exe: inst.exe, version: version ?? undefined }), userId) };
    }
    return { job: startJob(serverId, 'update', hostInstallCommand(version ?? undefined), userId) };
  }

  const value = typeof p.value === 'string' ? p.value : undefined;
  if (inst.kind === 'docker') {
    if (action === 'set_startup') throw new OllamaManageError('A container has a restart policy, not a startup method', 400, 'WRONG_KIND');
    if (action === 'set_restart_policy' && !(RESTART_POLICIES as readonly string[]).includes(value ?? '')) throw new OllamaManageError('Invalid restart policy', 400, 'BAD_VALUE');
    const out = await runQuick(serverId, dockerControlCommand(action, inst.container as string, value), `${action.replace('_', ' ')}`);
    return { message: out || 'Done' };
  }
  // A service
  if (action === 'set_restart_policy') throw new OllamaManageError('A service has a startup method, not a restart policy', 400, 'WRONG_KIND');
  const allowed = windows ? WINDOWS_STARTUP : SYSTEMD_STARTUP;
  if (action === 'set_startup' && !(allowed as readonly string[]).includes(value ?? '')) throw new OllamaManageError('Invalid startup method', 400, 'BAD_VALUE');
  const command = windows
    ? windowsServiceScript(action, inst.name as string, value)
    : systemdCommand(action, inst.name as string, value);
  const out = await runQuick(serverId, command, `${action.replace('_', ' ')}`);
  return { message: out || 'Done' };
}
