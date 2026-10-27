import crypto from 'crypto';
import { loadServerTarget, runOnServerId, sshPool } from '@/lib/ssh/connection-pool';
import * as sshHelpers from '@/lib/collect/ssh';
import { powershellCommand } from '@/lib/collect/windows';

/**
 * Ollama model management on a monitored host, through the host's own
 * localhost API (http://127.0.0.1:11434) over SSH, so Ollama never has to be
 * exposed on the network.
 */

/** Ollama model names: registry/namespace/name:tag. */
export const MODEL_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._\-/:]{0,199}$/;

export function assertModelName(name: unknown): asserts name is string {
  if (typeof name !== 'string' || !MODEL_NAME_RE.test(name) || name.includes('..')) {
    throw Object.assign(new Error('Invalid model name'), { status: 400 });
  }
}

const API = 'http://127.0.0.1:11434';

/** Build a command that POSTs/DELETEs JSON to the local Ollama API. */
export function ollamaApiCommand(platform: 'linux' | 'windows', method: 'POST' | 'DELETE', path: string, body: object, stream: boolean): string {
  const json = JSON.stringify(body);
  if (platform === 'windows') {
    // PowerShell 5.1 mangles quotes in native-exe arguments; hand the body to
    // curl.exe through a temp file instead.
    return powershellCommand(
      `$f = [IO.Path]::GetTempFileName(); [IO.File]::WriteAllText($f, '${json.replace(/'/g, "''")}'); ` +
      `try { & curl.exe -s ${stream ? '-N ' : ''}-w "\`nHTTP_STATUS=%{http_code}\`n" -X ${method} ${API}${path} --data-binary "@$f" } finally { Remove-Item $f -ErrorAction SilentlyContinue }`);
  }
  return `curl -s ${stream ? '-N ' : ''}-w '\\nHTTP_STATUS=%{http_code}\\n' -X ${method} ${API}${path} --data-binary ${sshHelpers.shQuote(json)}`;
}

export async function deleteModel(serverId: string, name: string): Promise<{ success: boolean; message: string }> {
  assertModelName(name);
  const t = await loadServerTarget(serverId);
  const r = await sshPool.executeCommand(t.id, t.config, ollamaApiCommand(t.platform, 'DELETE', '/api/delete', { name }, false), { timeoutMs: 30_000 });
  const status = Number((r.stdout.match(/HTTP_STATUS=(\d+)/) || [])[1] || 0);
  const body = r.stdout.replace(/\n?HTTP_STATUS=\d+\s*$/, '').trim();
  if (status === 200) return { success: true, message: `Deleted ${name}` };
  if (status === 0) return { success: false, message: 'Ollama API not reachable on the host (is it running and is curl installed?)' };
  let msg = body;
  try { msg = JSON.parse(body).error || body; } catch { /* plain text */ }
  return { success: false, message: msg || `HTTP ${status}` };
}

export interface PullJob {
  id: string;
  serverId: string;
  model: string;
  status: 'running' | 'success' | 'error' | 'cancelled';
  phase: string;
  completed: number;
  total: number;
  percent: number | null;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
  startedBy: string;
}

interface JobEntry { job: PullJob; cancel: () => void }

const g = globalThis as unknown as { __bosunPullJobs?: Map<string, JobEntry> };
const jobs: Map<string, JobEntry> = g.__bosunPullJobs ?? (g.__bosunPullJobs = new Map());

const KEEP_FINISHED_MS = 10 * 60 * 1000;

function prune() {
  const now = Date.now();
  for (const [id, e] of Array.from(jobs.entries())) {
    if (e.job.finishedAt && now - e.job.finishedAt > KEEP_FINISHED_MS) jobs.delete(id);
  }
}

/** Apply one NDJSON progress line from /api/pull to a job. */
export function applyPullLine(job: PullJob, line: string): void {
  const status = line.match(/^HTTP_STATUS=(\d+)$/);
  if (status) {
    if (status[1] !== '200' && job.status === 'running') {
      job.status = 'error';
      job.error = job.error || `HTTP ${status[1]}`;
    }
    return;
  }
  let msg: { status?: string; total?: number; completed?: number; error?: string };
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.error) {
    job.status = 'error';
    job.error = msg.error;
    return;
  }
  if (msg.status) job.phase = msg.status;
  if (typeof msg.total === 'number' && msg.total > 0) {
    job.total = msg.total;
    job.completed = typeof msg.completed === 'number' ? msg.completed : job.completed;
    job.percent = Math.min(100, Math.round((job.completed / job.total) * 1000) / 10);
  }
  if (msg.status === 'success') {
    job.status = 'success';
    job.percent = 100;
  }
}

export async function startPull(serverId: string, model: string, userId: string): Promise<PullJob> {
  assertModelName(model);
  prune();
  for (const e of Array.from(jobs.values())) {
    if (e.job.serverId === serverId && e.job.model === model && e.job.status === 'running') return e.job;
  }
  const t = await loadServerTarget(serverId);
  const client = await sshPool.getConnection(t.id, t.config);
  const job: PullJob = {
    id: crypto.randomUUID(), serverId, model, status: 'running', phase: 'starting', completed: 0, total: 0,
    percent: null, error: null, startedAt: Date.now(), finishedAt: null, startedBy: userId,
  };
  const cmd = ollamaApiCommand(t.platform, 'POST', '/api/pull', { name: model, stream: true }, true);
  const s = sshHelpers.streamLines(client, cmd, (line: string) => applyPullLine(job, line));
  jobs.set(job.id, { job, cancel: s.cancel });
  s.done.then(({ exitCode, cancelled }: { exitCode: number; cancelled: boolean }) => {
    if (cancelled) job.status = 'cancelled';
    else if (job.status === 'running') {
      job.status = 'error';
      job.error = job.error || (exitCode === 0 ? 'pull ended without success' : `curl exited with ${exitCode} (is Ollama running?)`);
    }
    job.finishedAt = Date.now();
  }).catch((err: Error) => {
    job.status = 'error';
    job.error = err.message;
    job.finishedAt = Date.now();
  });
  return job;
}

export function listPullJobs(serverId: string): PullJob[] {
  prune();
  return Array.from(jobs.values()).map(e => e.job).filter(j => j.serverId === serverId).sort((a, b) => b.startedAt - a.startedAt);
}

export function cancelPull(serverId: string, jobId: string): boolean {
  const e = jobs.get(jobId);
  if (!e || e.job.serverId !== serverId || e.job.status !== 'running') return false;
  e.cancel();
  return true;
}

export { runOnServerId };
