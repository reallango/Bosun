'use client';

import { useCallback, useRef, useState } from 'react';
import { Dialog } from 'radix-ui';
import dynamic from 'next/dynamic';
import { X } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useWidgetJob } from '@/hooks/useWidgetJob';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import { WidgetLoading } from '@/components/widgets/WidgetLoading';
import { ConfirmActionDialog, apiAction } from '@/components/widgets/shared/ConfirmActionDialog';
import { fillTemplate, getPath, type ParamSpec } from '@/lib/widgets/runtime/spec';
import type { PublicActionLike } from '@/lib/widgets/runtime/layout';
import { hasRole } from '@/lib/auth/levels';
import { IconBtn, type Row } from './parts';

// The terminal (xterm) loads only when a container shell is opened.
const SSHTerminalWidget = dynamic(
  () => import('@/components/widgets/ssh-terminal').then(m => m.SSHTerminalWidget),
  { ssr: false, loading: () => <WidgetLoading /> },
);

export type PublicAction = PublicActionLike;

/** The values an action is called with: a parameter's `from` field of the row, else its default. */
export function paramsFor(action: PublicAction, row: Row | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, p] of Object.entries(action.params) as [string, ParamSpec][]) {
    const fromRow = p.from && row ? getPath(row, p.from) : undefined;
    out[name] = fromRow !== undefined && fromRow !== null ? (p.type === 'number' ? Number(fromRow) : p.type === 'boolean' ? Boolean(fromRow) : String(fromRow)) : p.default;
  }
  return out;
}

interface Pending { action: PublicAction; row: Row | null; params?: Record<string, unknown>; resolve?: (ok: boolean) => void }

interface Options {
  actions: PublicAction[];
  version: number;
  serverId: string;
  widgetType: string;
  widgetId: string;
  /** What `{field}` in a confirmation reads when the action was not started from a row. */
  templateContext: unknown;
  /** The title of a row, for the output window of an action with a text result. */
  rowTitle?: (row: Row) => string;
  /** Called after an action changed something on the host (refresh the data shown). */
  changed: () => void;
  /** A `screen` action was clicked: open that screen with the row as its context. */
  openScreen?: (screenId: string, row: Row | null) => void;
}

/**
 * Starts the actions of a package widget for the widget and for its screens: confirmation, the API call (the same one API
 * keys use), toasts, text output, terminals and jobs. `dialogs` holds the pop-ups it needs; render it once.
 */
export function useActionRunner(o: Options) {
  const { user, can } = useAuth();
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [output, setOutput] = useState<{ title: string; text: string } | null>(null);
  const [shellFor, setShellFor] = useState<{ token: string; label: string } | null>(null);
  const { job, refresh: refreshJob, cancel } = useWidgetJob(o.serverId, o.widgetType, o.actions.some(a => a.job));
  const settled = useRef(false);

  // A web terminal asks for the person's own login and is only available to Full access; the action's permission still applies.
  const allowed = useCallback((a: PublicAction) => can(a.permission, o.serverId) && (a.kind !== 'terminal' || hasRole(user?.role, 'admin')), [can, o.serverId, user?.role]);

  /** Runs the action; throws when it fails (a confirmation dialog shows the message). */
  const run = useCallback(async (action: PublicAction, row: Row | null, override?: Record<string, unknown>) => {
    setBusy(action.id);
    try {
      const d = await apiAction(fetchWithAuth, `/api/servers/${o.serverId}/widget-actions/${encodeURIComponent(o.widgetType)}/${encodeURIComponent(action.id)}`, 'POST', {
        params: override ?? paramsFor(action, row), ...(action.confirm ? { confirm: true } : {}), ...(o.version >= 2 ? { widgetId: o.widgetId } : {}),
      }) as { success?: boolean; output?: string; error?: string; exitCode?: number; timedOut?: boolean; message?: string; jobId?: string };
      if (d.jobId) { await refreshJob(); return; }   // started in the background: the job block follows it
      const text = [d.output, d.error].filter(s => s && s.trim()).join('\n').trim();
      if (!d.success) throw new Error((d.message || text).slice(0, 300) || (d.timedOut ? 'The command timed out' : `The command failed (exit ${d.exitCode})`));
      if (action.result === 'text') setOutput({ title: `${action.label}${row && o.rowTitle ? `: ${o.rowTitle(row)}` : ''}`, text: text || '(no output)' });
      else if (action.result === 'toast') setNotice(`${action.label}: ${d.message || (text ? text.split('\n')[0].slice(0, 120) : 'done')}`);
      if (action.after === 'refresh') setTimeout(o.changed, 2500);
    } finally {
      setBusy(null);
    }
  }, [o.serverId, o.widgetType, o.widgetId, o.version, o.rowTitle, o.changed, refreshJob]);

  /** Start an action from a row, a button or a form. Asks for confirmation first when the action does. */
  const start = useCallback((action: PublicAction, row: Row | null, params?: Record<string, unknown>) => {
    if (action.kind === 'screen') { if (action.screen) o.openScreen?.(action.screen, row); return; }
    if (action.kind === 'terminal') {
      const ref = action.terminal ? String(getPath(row, action.terminal.ref) ?? '') : '';
      if (!ref) { setNotice(`${action.label}: this row has nothing to open it in`); return; }
      // The server checks the target and signs the command the package declared; the terminal then asks for the person's own login.
      apiAction(fetchWithAuth, `/api/servers/${o.serverId}/widget-actions/${encodeURIComponent(o.widgetType)}/${encodeURIComponent(action.id)}`, 'POST', { ref })
        .then(d => { const x = d as { token?: string; label?: string }; if (x.token) setShellFor({ token: x.token, label: x.label || ref }); else setNotice(`${action.label}: no terminal token was returned`); })
        .catch(err => setNotice(`${action.label}: ${err instanceof Error ? err.message : String(err)}`));
      return;
    }
    if (action.confirm) setPending({ action, row, params });
    else run(action, row, params).catch(err => setNotice(`${action.label} failed: ${err instanceof Error ? err.message : String(err)}`));
  }, [o, run]);

  /** Like `start` for a form that wants to know how it went: resolves true when the action ran and succeeded. */
  const submit = useCallback((action: PublicAction, params: Record<string, unknown>): Promise<boolean> => {
    if (action.confirm) {
      settled.current = false;
      return new Promise<boolean>(resolve => setPending({ action, row: null, params, resolve }));
    }
    return run(action, null, params).then(() => true, err => { setNotice(`${action.label} failed: ${err instanceof Error ? err.message : String(err)}`); return false; });
  }, [run]);

  const confirmCtx = (pending?.row ?? o.templateContext) as unknown;

  const dialogs = (
    <>
      <ConfirmActionDialog
        open={!!pending}
        onOpenChange={open => { if (!open) { if (pending?.resolve && !settled.current) pending.resolve(false); setPending(null); } }}
        title={pending?.action.confirm ? fillTemplate(pending.action.confirm.title, confirmCtx) : ''}
        description={pending?.action.confirm?.text ? fillTemplate(pending.action.confirm.text, confirmCtx) : (pending?.action.label ?? '')}
        confirmLabel={pending?.action.label ?? ''}
        destructive={!!pending?.action.confirm?.destructive}
        requireText={pending?.action.confirm?.requireText ? fillTemplate(pending.action.confirm.requireText, confirmCtx) : undefined}
        onConfirm={async () => {
          if (!pending) return;
          await run(pending.action, pending.row, pending.params);   // a failure is shown in the dialog
          settled.current = true;
          pending.resolve?.(true);
        }}
      />

      <Dialog.Root open={!!shellFor} onOpenChange={open => { if (!open) setShellFor(null); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/50" />
          <Dialog.Content className="fixed inset-0 z-[60] flex flex-col bg-white p-2 shadow-xl dark:bg-gray-900 sm:inset-6 sm:rounded-xl sm:border sm:border-gray-700 lg:inset-x-[8%]">
            <div className="mb-2 flex items-center justify-between gap-2 px-1">
              <Dialog.Title className="truncate font-semibold">{shellFor?.label}</Dialog.Title>
              <Dialog.Description className="sr-only">Interactive terminal session</Dialog.Description>
              <Dialog.Close asChild><IconBtn label="Close shell"><X /></IconBtn></Dialog.Close>
            </div>
            <div className="min-h-0 flex-1">
              {shellFor && <SSHTerminalWidget widgetId={`${o.widgetId}:exec:${shellFor.label}`} serverId={o.serverId} cmdToken={shellFor.token} cmdLabel={shellFor.label} />}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={!!output} onOpenChange={open => { if (!open) setOutput(null); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/50" />
          <Dialog.Content className="fixed inset-2 z-[60] flex flex-col rounded-xl border border-gray-200 bg-white p-3 shadow-xl dark:border-gray-700 dark:bg-gray-900 sm:inset-8 lg:inset-x-[10%]">
            <div className="mb-2 flex items-center justify-between gap-2">
              <Dialog.Title className="truncate font-semibold">{output?.title}</Dialog.Title>
              <Dialog.Description className="sr-only">Output of the action</Dialog.Description>
              <Dialog.Close asChild><IconBtn label="Close"><X /></IconBtn></Dialog.Close>
            </div>
            <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded bg-gray-950 p-2 font-mono text-[11px] leading-snug text-gray-100">{output?.text}</pre>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );

  return { busy, notice, setNotice, job, cancelJob: cancel, allowed, run, start, submit, dialogs };
}
