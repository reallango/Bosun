'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ArrowUpCircle, ChevronDown, ChevronRight, Loader2, Play, RotateCw, Square, TriangleAlert } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import { ConfirmActionDialog, apiAction } from '@/components/widgets/shared/ConfirmActionDialog';

interface Install {
  kind: 'docker' | 'service' | 'standard' | 'none';
  dockerAvailable?: boolean;
  manager?: 'nssm' | 'windows' | 'systemd';
  name?: string;
  container?: string;
  image?: string;
  state?: string;
  restartPolicy?: string;
  startMode?: string;
  path?: string;
}

interface Job {
  action: 'install' | 'update';
  status: 'running' | 'success' | 'error';
  startedAt: number;
  steps: string[];
  message: string | null;
}

interface Info {
  platform: 'linux' | 'windows';
  version: string | null;
  install: Install | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  job: Job | null;
}

type Pending = { action: 'stop' | 'restart' | 'update' | 'install'; method?: 'docker' | 'host' } | null;

const STARTUP_LABEL: Record<string, string> = {
  auto: 'Automatic', delayed: 'Automatic (delayed)', manual: 'Manual', disabled: 'Disabled', enabled: 'Enabled at boot',
};
const WINDOWS_STARTUP = ['auto', 'delayed', 'manual', 'disabled'];
const SYSTEMD_STARTUP = ['enabled', 'disabled'];
const RESTART_POLICIES: [string, string][] = [['no', 'Never'], ['always', 'Always'], ['unless-stopped', 'Unless stopped'], ['on-failure', 'On failure']];

function describe(i: Install, platform: string): string {
  if (i.kind === 'docker') return `Docker container ${i.container}`;
  if (i.kind === 'service') return i.manager === 'nssm' ? `Windows service ${i.name} (nssm)` : i.manager === 'systemd' ? `systemd service ${i.name}` : `Windows service ${i.name}`;
  if (i.kind === 'standard') return platform === 'windows' ? 'Standard install (not a service)' : 'Standard install (no service or container)';
  return 'Not installed';
}

function minutes(since: number): string {
  const s = Math.max(0, Math.round((Date.now() - since) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** How Ollama is installed on the host, and the controls for that: update, start/stop, startup method, install. */
export function OllamaServicePanel({ serverId, onChanged }: { serverId: string; onChanged: () => void }) {
  const { can } = useAuth();
  const canManage = can('ollama.service', serverId);
  const [info, setInfo] = useState<Info | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  // Collapsed until asked for; a badge next to the arrow tells when something needs attention.
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      setInfo(await apiAction(fetchWithAuth, `/api/servers/${serverId}/ollama/service`, 'GET') as Info);
    } catch { /* transient */ }
  }, [serverId]);

  const jobRunning = info?.job?.status === 'running';
  useEffect(() => {
    load();
    const t = setInterval(load, jobRunning ? 3000 : 20000);
    return () => clearInterval(t);
  }, [load, jobRunning]);

  // When a job finishes, have the model list refresh.
  const jobStatus = info?.job?.status;
  useEffect(() => { if (jobStatus === 'success') onChanged(); }, [jobStatus, onChanged]);

  if (!info || !info.install) return null;
  const inst = info.install;

  const call = async (action: string, extra: Record<string, unknown> = {}, label = action) => {
    setBusy(label);
    setMessage(null);
    try {
      const needsConfirm = ['stop', 'restart', 'install', 'update'].includes(action);
      const d = await apiAction(fetchWithAuth, `/api/servers/${serverId}/ollama/service`, 'POST', { action, ...extra, ...(needsConfirm ? { confirm: true } : {}) }) as { message?: string };
      if (d?.message) setMessage({ text: d.message });
      await load();
      setTimeout(() => { load(); onChanged(); }, 2500);
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : String(err), error: true });
    } finally {
      setBusy(null);
    }
  };

  const startupOptions = info.platform === 'windows' ? WINDOWS_STARTUP : SYSTEMD_STARTUP;
  const running = inst.state === 'running';
  const stateText = inst.kind === 'service' || inst.kind === 'docker' ? (running ? 'running' : inst.state === 'failed' ? 'failed' : 'stopped') : '';
  const manageable = inst.kind === 'service' || inst.kind === 'docker';

  const button = (label: string, icon: ReactNode, onClick: () => void, disabled = false) => (
    <button type="button" onClick={onClick} disabled={disabled || busy !== null || jobRunning}
      className="flex items-center gap-1 rounded-md border border-gray-200 px-2 py-0.5 text-xs hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-800">
      {busy === label ? <Loader2 className="size-3 animate-spin" aria-hidden /> : icon}{label}
    </button>
  );

  return (
    <div className="rounded-md border border-gray-200 p-2 text-xs dark:border-gray-700" aria-label="Ollama installation">
      <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open} aria-controls="ollama-install-body"
        className="flex w-full flex-wrap items-center gap-x-2 gap-y-1 text-left">
        {open ? <ChevronDown className="size-3.5 shrink-0 text-gray-500" aria-hidden /> : <ChevronRight className="size-3.5 shrink-0 text-gray-500" aria-hidden />}
        {info.updateAvailable && (
          <span className="flex shrink-0 items-center gap-1 rounded-full bg-blue-600 px-2 py-0.5 text-[10px] font-semibold text-white">
            <ArrowUpCircle className="size-3" aria-hidden /> Update available
          </span>
        )}
        {jobRunning && (
          <span className="flex shrink-0 items-center gap-1 rounded-full bg-amber-500 px-2 py-0.5 text-[10px] font-semibold text-white">
            <Loader2 className="size-3 animate-spin motion-reduce:animate-none" aria-hidden /> {info.job?.action === 'install' ? 'Installing' : 'Updating'}
          </span>
        )}
        {inst.kind === 'none' && !jobRunning && (
          <span className="shrink-0 rounded-full bg-gray-200 px-2 py-0.5 text-[10px] font-semibold text-gray-700 dark:bg-gray-700 dark:text-gray-200">Not installed</span>
        )}
        <span className="font-medium text-gray-900 dark:text-gray-100">Installation</span>
        <span className="min-w-0 truncate text-gray-500">
          {describe(inst, info.platform)}
          {manageable && ` · ${stateText}`}
          {inst.kind === 'service' && inst.startMode && ` · starts: ${STARTUP_LABEL[inst.startMode] ?? inst.startMode}`}
          {inst.kind === 'docker' && ` · restart: ${RESTART_POLICIES.find(p => p[0] === inst.restartPolicy)?.[1] ?? inst.restartPolicy ?? 'Never'}`}
        </span>
      </button>

      {open && (
      <div id="ollama-install-body" className="mt-1.5 space-y-1.5">
      {info.updateAvailable && (
        <div className="flex flex-wrap items-center gap-2 rounded bg-blue-50 px-2 py-1 text-blue-800 dark:bg-blue-950/50 dark:text-blue-200">
          <ArrowUpCircle className="size-3.5" aria-hidden />
          <span>Update available: v{info.version} → v{info.latestVersion}</span>
          {canManage && button('Update', <ArrowUpCircle className="size-3" aria-hidden />, () => setPending({ action: 'update' }))}
        </div>
      )}

      {canManage && manageable && !jobRunning && (
        <div className="flex flex-wrap items-center gap-1.5">
          {!running && button('Start', <Play className="size-3" aria-hidden />, () => call('start', {}, 'Start'))}
          {running && button('Stop', <Square className="size-3" aria-hidden />, () => setPending({ action: 'stop' }))}
          {running && button('Restart', <RotateCw className="size-3" aria-hidden />, () => setPending({ action: 'restart' }))}
          {inst.kind === 'service' && (
            <label className="flex items-center gap-1 text-gray-500">
              Startup
              <select value={inst.startMode} disabled={busy !== null}
                onChange={e => call('set_startup', { value: e.target.value }, 'Startup')}
                className="rounded border border-gray-200 bg-transparent px-1 py-0.5 dark:border-gray-700">
                {startupOptions.map(o => <option key={o} value={o}>{STARTUP_LABEL[o] ?? o}</option>)}
                {inst.startMode && !startupOptions.includes(inst.startMode) && <option value={inst.startMode}>{inst.startMode}</option>}
              </select>
            </label>
          )}
          {inst.kind === 'docker' && (
            <label className="flex items-center gap-1 text-gray-500">
              Restart policy
              <select value={inst.restartPolicy || 'no'} disabled={busy !== null}
                onChange={e => call('set_restart_policy', { value: e.target.value }, 'Restart policy')}
                className="rounded border border-gray-200 bg-transparent px-1 py-0.5 dark:border-gray-700">
                {RESTART_POLICIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
          )}
        </div>
      )}

      {inst.kind === 'standard' && (
        <p className="text-gray-500">
          Bosun cannot start, stop or update a standard install.
          {info.platform === 'windows' ? ' Install Ollama as a service (nssm) to manage it from here.' : ' Install it as a Docker container or a systemd service to manage it from here.'}
        </p>
      )}

      {inst.kind === 'none' && canManage && !jobRunning && (
        <div className="space-y-1">
          <p className="text-gray-500">Ollama is not installed on this server.</p>
          {info.platform === 'windows' ? (
            <div className="flex flex-wrap items-center gap-2">
              {button('Install as a service', <ArrowUpCircle className="size-3" aria-hidden />, () => setPending({ action: 'install' }))}
              <span className="text-gray-500">Downloads Ollama into C:\Ollama and runs it with nssm, started at boot, listening on localhost only.</span>
            </div>
          ) : (
            <>
              {!inst.dockerAvailable && (
                <p className="flex items-start gap-1 text-amber-700 dark:text-amber-400">
                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                  <span>Docker is not installed (or this server&apos;s Bosun account cannot use it), so the recommended Docker install is not available.</span>
                </p>
              )}
              <div className="flex flex-wrap items-center gap-2">
                {inst.dockerAvailable && button('Install with Docker', <ArrowUpCircle className="size-3" aria-hidden />, () => setPending({ action: 'install', method: 'docker' }))}
                {button('Install on the host', <ArrowUpCircle className="size-3" aria-hidden />, () => setPending({ action: 'install', method: 'host' }))}
              </div>
            </>
          )}
        </div>
      )}
      {inst.kind === 'none' && !canManage && <p className="text-gray-500">Ollama is not installed on this server.</p>}

      {info.job && (
        <div className={info.job.status === 'error' ? 'text-red-600' : info.job.status === 'success' ? 'text-green-700 dark:text-green-400' : 'text-gray-600 dark:text-gray-300'} role="status">
          {info.job.status === 'running' && <Loader2 className="mr-1 inline size-3 animate-spin motion-reduce:animate-none" aria-hidden />}
          {info.job.action === 'install' ? 'Install' : 'Update'}{' '}
          {info.job.status === 'running' ? `running for ${minutes(info.job.startedAt)}` : info.job.status === 'success' ? `finished${info.job.message ? `: ${info.job.message}` : ''}` : `failed: ${info.job.message ?? 'unknown error'}`}
          {info.job.status === 'running' && info.job.steps.length > 0 && <span className="text-gray-500"> · {info.job.steps[info.job.steps.length - 1]}</span>}
        </div>
      )}
      {message && <div role="alert" className={message.error ? 'text-red-600' : 'text-gray-600 dark:text-gray-300'}>{message.text}</div>}
      </div>
      )}

      <ConfirmActionDialog
        open={!!pending}
        onOpenChange={o => { if (!o) setPending(null); }}
        title={pending ? ({ stop: 'Stop Ollama?', restart: 'Restart Ollama?', update: `Update Ollama to v${info.latestVersion ?? 'latest'}?`, install: 'Install Ollama?' })[pending.action] : ''}
        description={pending ? ({
          stop: 'Models stop answering requests, and anything using Ollama on this host loses it until it is started again.',
          restart: 'Loaded models are unloaded and requests in flight fail while it restarts.',
          update: inst.kind === 'docker' ? 'The container is recreated from the new image with the same settings (ports, volumes, GPU access, restart policy). Ollama is unavailable while that happens.' : 'The service is stopped, its files are replaced and it is started again. Ollama is unavailable meanwhile.',
          install: info.platform === 'windows' ? 'Downloads about 1.5 GB, unpacks it into C:\\Ollama and creates a Windows service with nssm (installed with winget when it is missing).' : pending.method === 'host' ? 'Runs the official install script with sudo. It adds the ollama user and a systemd service.' : 'Pulls the ollama/ollama image and starts a container that keeps its models in a Docker volume.',
        })[pending.action] : ''}
        confirmLabel={pending ? ({ stop: 'Stop', restart: 'Restart', update: 'Update', install: 'Install' })[pending.action] : ''}
        destructive={pending?.action === 'stop' || pending?.action === 'restart'}
        onConfirm={async () => { if (pending) await call(pending.action, pending.method ? { method: pending.method } : {}, pending.action); }}
      />
    </div>
  );
}
