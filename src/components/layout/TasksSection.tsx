'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Dialog } from 'radix-ui';
import { CircleAlert, CircleCheck, Copy, Loader2, SquareArrowOutUpRight, X } from 'lucide-react';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import { readJson } from '@/lib/api/readJson';
import { formatDistanceToNow } from '@/lib/utils/date';
import { cn } from '@/lib/utils';
import type { Task } from '@/hooks/useTasks';

const STATUS_TEXT: Record<Task['status'], string> = { running: 'Running', success: 'Done', error: 'Failed', cancelled: 'Cancelled', lost: 'Lost track of' };

function StatusIcon({ status }: { status: Task['status'] }) {
  if (status === 'running') return <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-primary motion-reduce:animate-none" aria-label="Running" />;
  if (status === 'success') return <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" aria-label="Done" />;
  return <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-label={STATUS_TEXT[status]} />;
}

/** Everything a task did, in a pop-up: its steps and the log of the script (secrets are never in it). */
function LogDialog({ task, onClose }: { task: Task | null; onClose: () => void }) {
  const [log, setLog] = useState<{ id: string; steps: string[]; text: string; message: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const id = task?.id;
  // loaded when a task is opened
  useEffect(() => {
    if (!id) return;
    let live = true;
    setLog(null); setError(null);
    (async () => {
      try {
        const res = await fetchWithAuth(`/api/widget-jobs/${encodeURIComponent(id)}`);
        const json = await readJson<{ data?: { task: { steps: string[]; message: string | null }; log: string }; error?: { message?: string } }>(res);
        if (!live) return;
        if (!res.ok || !json.data) { setError(json.error?.message || `HTTP ${res.status}`); return; }
        setLog({ id, steps: json.data.task.steps, text: json.data.log, message: json.data.task.message });
      } catch (e) { if (live) setError(e instanceof Error ? e.message : String(e)); }
    })();
    return () => { live = false; };
  }, [id]);
  const close = () => { setLog(null); setError(null); onClose(); };
  const text = log ? [log.message ? `Result: ${log.message}` : '', log.steps.length ? `Steps:\n${log.steps.map(s => `  ${s}`).join('\n')}` : '', log.text ? `\nOutput:\n${log.text}` : ''].filter(Boolean).join('\n') : '';
  return (
    <Dialog.Root open={!!task} onOpenChange={o => { if (!o) close(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[70] bg-black/50" />
        <Dialog.Content className="fixed inset-x-2 top-8 z-[70] mx-auto flex max-h-[85vh] flex-col rounded-xl border bg-popover p-4 text-popover-foreground shadow-xl sm:max-w-3xl" aria-describedby={undefined}>
          <div className="mb-2 flex items-start justify-between gap-2">
            <Dialog.Title className="min-w-0 truncate text-base font-semibold">{task ? `${task.actionLabel} on ${task.serverName}` : ''}</Dialog.Title>
            <Dialog.Close asChild><button type="button" className="rounded p-1 text-muted-foreground hover:bg-accent" aria-label="Close"><X className="size-4" /></button></Dialog.Close>
          </div>
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : !log ? <p className="text-sm text-muted-foreground">Loading…</p> : (
            <>
              <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded bg-gray-950 p-3 font-mono text-[11px] leading-snug text-gray-100">{text || '(no output)'}</pre>
              <div className="mt-2 flex justify-end">
                <button type="button" className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-accent"
                  onClick={async () => { try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* select by hand */ } }}>
                  <Copy className="size-3" aria-hidden /> {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** The tasks at the top of the notification list: what is running, what finished, with its log and the way back to its screen. */
export function TasksSection({ tasks, seen, markSeen, onNavigate, reload }: { tasks: Task[]; seen: Set<string>; markSeen: (ids: string[]) => void; onNavigate: () => void; reload: () => void }) {
  const router = useRouter();
  const [logOf, setLogOf] = useState<Task | null>(null);
  if (!tasks.length) return null;
  const cancel = async (t: Task) => {
    await fetchWithAuth(`/api/servers/${t.serverId}/widget-jobs/${encodeURIComponent(t.widgetType)}/${t.id}/cancel`, { method: 'POST' }).catch(() => undefined);
    reload();
  };
  return (
    <div className="border-b">
      <div className="flex items-center justify-between px-3 pb-1 pt-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Tasks</span>
        {tasks.some(t => t.status !== 'running' && !seen.has(t.id)) && (
          <button type="button" className="text-xs text-primary hover:underline" onClick={() => markSeen(tasks.filter(t => t.status !== 'running').map(t => t.id))}>Mark all seen</button>
        )}
      </div>
      <ul>
        {tasks.slice(0, 6).map(t => (
          <li key={t.id} className={cn('flex items-start gap-2 border-t px-3 py-2', t.status !== 'running' && !seen.has(t.id) && 'bg-primary/5')}>
            <StatusIcon status={t.status} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{t.actionLabel} <span className="font-normal text-muted-foreground">on {t.serverName}</span></div>
              <div className="line-clamp-2 break-words text-xs text-muted-foreground">
                {t.status === 'running' ? (t.steps[t.steps.length - 1] || 'Starting…') : `${STATUS_TEXT[t.status]}${t.message ? `: ${t.message}` : ''}`}
              </div>
              {t.status === 'running' && t.percent !== null && (
                <div className="mt-1 h-1 w-full overflow-hidden rounded bg-muted"><div className="h-full bg-primary" style={{ width: `${t.percent}%` }} /></div>
              )}
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                <span className="text-muted-foreground/80">{formatDistanceToNow(new Date(t.finishedAt ?? t.startedAt))}</span>
                <button type="button" className="text-primary hover:underline" onClick={() => { setLogOf(t); markSeen([t.id]); }}>Log</button>
                {t.screenId && t.widgetId && (
                  <button type="button" className="inline-flex items-center gap-0.5 text-primary hover:underline"
                    onClick={() => { markSeen([t.id]); onNavigate(); router.push(`/widgets/${encodeURIComponent(t.widgetId!)}/${encodeURIComponent(t.screenId!)}?job=${encodeURIComponent(t.id)}`); }}>
                    Open the screen <SquareArrowOutUpRight className="size-3" aria-hidden />
                  </button>
                )}
                {t.status === 'running' && !t.cancelRequested && <button type="button" className="text-destructive hover:underline" onClick={() => cancel(t)}>Cancel</button>}
              </div>
            </div>
          </li>
        ))}
      </ul>
      <LogDialog task={logOf} onClose={() => setLogOf(null)} />
    </div>
  );
}
