'use client';

import { useCallback, useEffect, useState } from 'react';
import { Download, Trash2, X, Cpu, Loader2 } from 'lucide-react';
import { useWidgetData } from '@/hooks/useWidgetData';
import { useAuth } from '@/hooks/useAuth';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import { WidgetLoading } from '@/components/widgets/WidgetLoading';
import { WidgetError } from '@/components/widgets/WidgetError';
import { ConfirmActionDialog, apiAction } from '@/components/widgets/shared/ConfirmActionDialog';
import { OllamaServicePanel } from './OllamaServicePanel';

interface Model {
  name: string;
  size: number;
  parameter_size?: string;
  quantization_level?: string;
  family?: string;
  loaded?: boolean;
  modified_at?: string;
}

interface OllamaData {
  status: 'running' | 'stopped' | 'error' | 'unknown';
  version?: string | null;
  models: Model[];
  running: { name: string; size?: number; size_vram?: number }[];
}

interface PullJob {
  id: string;
  model: string;
  status: 'running' | 'success' | 'error' | 'cancelled';
  phase: string;
  percent: number | null;
  completed: number;
  total: number;
  error: string | null;
}

const MODEL_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._\-/:]{0,199}$/;

export function formatBytes(n: number): string {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i >= 3 ? 1 : 0)} ${u[i]}`;
}

interface Props {
  widgetId: string;
  serverId: string;
}

export function OllamaStatusWidget({ widgetId, serverId }: Props) {
  const { data, isLoading, error, refresh } = useWidgetData(widgetId, 30);
  const { can } = useAuth();
  // Pull/cancel/delete models: Read + actions or higher.
  const canPull = can('ollama.models.pull', serverId);
  const canDelete = can('ollama.models.delete', serverId);
  const [pulls, setPulls] = useState<PullJob[]>([]);
  const [newModel, setNewModel] = useState('');
  const [pullError, setPullError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [toDelete, setToDelete] = useState<Model | null>(null);

  const loadPulls = useCallback(async () => {
    try {
      const d = await apiAction(fetchWithAuth, `/api/servers/${serverId}/ollama/pull`, 'GET') as { pulls: PullJob[] };
      setPulls(prev => {
        // A pull just finished: refresh the model list shortly after.
        if (prev.some(p => p.status === 'running') && !d.pulls.some(p => p.status === 'running')) setTimeout(refresh, 3000);
        return d.pulls;
      });
    } catch { /* transient */ }
  }, [serverId, refresh]);

  const anyRunning = pulls.some(p => p.status === 'running');
  useEffect(() => {
    loadPulls();
    const t = setInterval(loadPulls, anyRunning ? 1000 : 15000);
    return () => clearInterval(t);
  }, [loadPulls, anyRunning]);

  const ollama = data as OllamaData | null;
  if (isLoading && !data) return <WidgetLoading />;
  if (error) return <WidgetError error={error} onRetry={refresh} serverId={serverId} />;
  if (!ollama) return <div className="p-2 text-sm text-gray-500">Waiting for the first poll of this host…</div>;

  const startPull = async () => {
    const model = newModel.trim();
    if (!MODEL_NAME_RE.test(model)) { setPullError('Enter a model name like llama3.2:1b'); return; }
    setStarting(true);
    setPullError(null);
    try {
      await apiAction(fetchWithAuth, `/api/servers/${serverId}/ollama/pull`, 'POST', { model });
      setNewModel('');
      await loadPulls();
    } catch (err) {
      setPullError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  };

  const cancel = async (job: PullJob) => {
    try {
      await apiAction(fetchWithAuth, `/api/servers/${serverId}/ollama/pull?jobId=${encodeURIComponent(job.id)}`, 'DELETE');
    } finally {
      loadPulls();
    }
  };

  const totalSize = ollama.models.reduce((a, m) => a + (m.size || 0), 0);
  const statusColor = ollama.status === 'running' ? 'bg-green-500' : ollama.status === 'stopped' ? 'bg-red-500' : 'bg-amber-500';

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500">
        <span className="flex items-center gap-1.5">
          <span className={`size-2 rounded-full ${statusColor}`} aria-hidden />
          <span className="font-medium text-gray-900 dark:text-gray-100">{ollama.status}</span>
          {ollama.version && <span>v{ollama.version}</span>}
        </span>
        <span>{ollama.models.length} models · {formatBytes(totalSize)}</span>
        {ollama.running.length > 0 && (() => {
          // Loaded models: total resident memory and how much of it is in VRAM
          // (the rest is offloaded to system RAM / CPU).
          const total = ollama.running.reduce((a, m) => a + (m.size || 0), 0);
          const gpu = ollama.running.reduce((a, m) => a + (m.size_vram || 0), 0);
          const gpuPct = total > 0 ? Math.round((gpu / total) * 100) : 0;
          return (
            <span className="flex items-center gap-1 text-green-600 dark:text-green-400" title={`${formatBytes(gpu)} in VRAM, ${formatBytes(total - gpu)} on CPU`}>
              <Cpu className="size-3" aria-hidden /> {ollama.running.length} loaded · {formatBytes(total)} · {gpuPct}% GPU / {100 - gpuPct}% CPU
            </span>
          );
        })()}
      </div>

      <OllamaServicePanel serverId={serverId} onChanged={refresh} />

      {canPull && ollama.status === 'running' && (
        <form className="flex gap-1.5" onSubmit={e => { e.preventDefault(); startPull(); }}>
          <input
            value={newModel}
            onChange={e => setNewModel(e.target.value)}
            placeholder="Pull model, e.g. llama3.2:1b"
            aria-label="Model to pull"
            className="min-w-0 flex-1 rounded-md border border-gray-200 bg-transparent px-2 py-1 text-xs outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-700"
          />
          <button type="submit" disabled={starting || !newModel.trim()}
            className="flex items-center gap-1 rounded-md bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50">
            {starting ? <Loader2 className="size-3 animate-spin" /> : <Download className="size-3" />} Pull
          </button>
        </form>
      )}
      {pullError && <p role="alert" className="text-xs text-red-600">{pullError}</p>}

      {pulls.filter(p => p.status === 'running' || p.status === 'error').slice(0, 4).map(p => (
        <div key={p.id} className="rounded-md border border-gray-200 p-1.5 text-xs dark:border-gray-700">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate font-medium">{p.model}</span>
            <span className="shrink-0 text-gray-500">
              {p.status === 'error' ? <span className="text-red-600">failed</span> : p.percent !== null ? `${p.percent}%` : p.phase}
            </span>
            {p.status === 'running' && canPull && (
              <button onClick={() => cancel(p)} aria-label={`Cancel pull of ${p.model}`} className="text-gray-400 hover:text-red-600"><X className="size-3" /></button>
            )}
          </div>
          {p.status === 'running' && (
            <>
              <div className="mt-1 h-1.5 overflow-hidden rounded bg-gray-200 dark:bg-gray-700">
                <div className="h-full bg-blue-600 transition-all" style={{ width: `${p.percent ?? 2}%` }} />
              </div>
              <div className="mt-0.5 truncate text-[10px] text-gray-500">
                {p.phase}{p.total ? ` · ${formatBytes(p.completed)} / ${formatBytes(p.total)}` : ''}
              </div>
            </>
          )}
          {p.status === 'error' && <div className="mt-0.5 break-words text-[11px] text-red-600">{p.error}</div>}
        </div>
      ))}

      <ul className="min-h-0 flex-1 divide-y divide-gray-100 overflow-auto dark:divide-gray-800">
        {ollama.models.map(m => (
          <li key={m.name} className="flex items-center gap-2 py-1.5">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate font-medium">{m.name}</span>
                {m.loaded && <span className="shrink-0 rounded bg-green-100 px-1 text-[10px] text-green-700 dark:bg-green-900/50 dark:text-green-300">loaded</span>}
              </div>
              <div className="truncate text-xs text-gray-500">
                {[formatBytes(m.size), m.parameter_size, m.quantization_level, m.family].filter(Boolean).join(' · ')}
              </div>
            </div>
            {canDelete && (
              <button
                type="button"
                onClick={() => setToDelete(m)}
                aria-label={`Delete ${m.name}`}
                title={`Delete ${m.name}`}
                className="shrink-0 rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-red-600 dark:hover:bg-gray-800"
              >
                <Trash2 className="size-3.5" />
              </button>
            )}
          </li>
        ))}
        {ollama.models.length === 0 && (
          <li className="py-4 text-center text-xs text-gray-500">{ollama.status === 'running' ? 'No models installed' : 'Ollama is not reachable on this host'}</li>
        )}
      </ul>

      <ConfirmActionDialog
        open={!!toDelete}
        onOpenChange={o => { if (!o) setToDelete(null); }}
        title={`Delete ${toDelete?.name}?`}
        description={toDelete && (
          <>This removes the model from the host and frees {formatBytes(toDelete.size)}. It has to be downloaded again to be used.
            {toDelete.loaded && ' It is currently loaded; requests using it will fail.'}</>
        )}
        confirmLabel="Delete model"
        destructive
        requireText={toDelete?.name}
        onConfirm={async () => {
          if (!toDelete) return;
          await apiAction(fetchWithAuth, `/api/servers/${serverId}/ollama/models`, 'DELETE', { name: toDelete.name, confirm: true });
          setTimeout(refresh, 2500);
        }}
      />
    </div>
  );
}
