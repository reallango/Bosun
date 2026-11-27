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
export function LogDialog({ task, onClose }: { task: Task | null; onClose: () => void }) {
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
  // the script's own protocol lines (PROGRESS n/m, [step] ..., DONE ..., ERROR: ...) read as a plain log
  const pretty = (s: string) => s.split('\n').filter(l => !/^PROGRESS\s/.test(l)).map(l => l.replace(/^\[step\]\s*/i, '• ').replace(/^DONE\s?/, 'Done: ').replace(/^ERROR:\s?/, 'Error: ')).join('\n');
  const text = log ? [log.message ? `Result: ${log.message}` : '', log.text ? `\nLog:\n${pretty(log.text)}` : (log.steps.length ? `Steps:\n${log.steps.map(s => `  ${s}`).join('\n')}` : '')].filter(Boolean).join('\n') : '';
  return (
    <Dialog.Root open={!!task} onOpenChange={o => { if (!o) close(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[70] bg-black/50" />
        <Dialog.Content className="fixed inset-x-2 top-8 z-[70] mx-auto flex max-h-[85vh] flex-col rounded-xl border bg-popover p-4 text-popover-foreground shadow-xl sm:max-w-3xl" aria-describedby={undefined}>
          <div className="mb-2 flex items-start justify-between gap-2">
            <Dialog.Title className="min-w-0 truncate text-base font-semibold">{task ? `${task.actionLabel} on ${task.serverName}${task.startedBy ? ` (by ${task.startedBy})` : ''}` : ''}</Dialog.Title>
            <Dialog.Close asChild><button type="button" className="rounded p-1 text-muted-foreground hover:bg-accent" aria-label="Close"><X className="size-4" /></button></Dialog.Close>
          </div>
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : !log ? <p className="text-sm text-muted-foreground">Loading…</p> : (
            <>
              <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-3 font-mono text-[11px] leading-snug text-foreground">{text || '(no output)'}</pre>
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

/**
 * One task row for the bell and the Activity page: what is running, what finished, with its log and
 * the way back to its screen. A finished task can be dismissed from the bell.
 */
export function TaskItem({
  task,
  seen,
  onSeen,
  onNavigate,
  onDismiss,
  onChanged,
  quiet = false,
}: {
  task: Task;
  seen: boolean;
  onSeen: (ids: string[]) => void;
  onNavigate?: () => void;
  onDismiss?: (id: string) => void;
  onChanged?: () => void;
  quiet?: boolean;
}) {
  const router = useRouter();
  const [logOpen, setLogOpen] = useState(false);
  const cancel = async () => {
    await fetchWithAuth(`/api/servers/${task.serverId}/widget-jobs/${encodeURIComponent(task.widgetType)}/${task.id}/cancel`, { method: 'POST' }).catch(() => undefined);
    onChanged?.();
  };
  return (
    <div className={cn(
      'group relative flex items-start gap-2 border-b px-3 py-2 last:border-b-0',
      !seen && task.status !== 'running' && !quiet && 'bg-primary/5',
      quiet && 'opacity-75',
    )}>
      <StatusIcon status={task.status} />
      <div className="min-w-0 flex-1 pr-6">
        <div className="truncate text-sm font-medium">{task.actionLabel} <span className="font-normal text-muted-foreground">on {task.serverName}</span></div>
        <div className="line-clamp-2 break-words text-xs text-muted-foreground">
          {task.status === 'running' ? (task.steps[task.steps.length - 1] || 'Starting…') : `${STATUS_TEXT[task.status]}${task.message ? `: ${task.message}` : ''}`}
        </div>
        {task.status === 'running' && task.percent !== null && (
          <div className="mt-1 h-1 w-full overflow-hidden rounded bg-muted"><div className="h-full bg-primary" style={{ width: `${task.percent}%` }} /></div>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted-foreground/80">{task.startedBy ? `${task.startedBy} · ` : ''}{formatDistanceToNow(new Date(task.finishedAt ?? task.startedAt))}</span>
          <button type="button" className="text-primary hover:underline" onClick={() => { setLogOpen(true); if (task.status !== 'running') onSeen([task.id]); }}>Log</button>
          {task.screenId && task.widgetId && (
            <button type="button" className="inline-flex items-center gap-0.5 text-primary hover:underline"
              onClick={() => { onSeen([task.id]); onNavigate?.(); router.push(`/widgets/${encodeURIComponent(task.widgetId!)}/${encodeURIComponent(task.screenId!)}?job=${encodeURIComponent(task.id)}`); }}>
              Open the screen <SquareArrowOutUpRight className="size-3" aria-hidden />
            </button>
          )}
          {task.status === 'running' && !task.cancelRequested && <button type="button" className="text-destructive hover:underline" onClick={cancel}>Cancel</button>}
        </div>
      </div>
      {onDismiss && task.status !== 'running' && (
        <button
          type="button"
          onClick={() => onDismiss(task.id)}
          aria-label={`Dismiss: ${task.actionLabel}`}
          className="absolute right-1.5 top-2 inline-flex size-7 items-center justify-center rounded-md text-muted-foreground opacity-60 hover:bg-accent hover:text-foreground hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="size-3.5" />
        </button>
      )}
      <LogDialog task={logOpen ? task : null} onClose={() => setLogOpen(false)} />
    </div>
  );
}
