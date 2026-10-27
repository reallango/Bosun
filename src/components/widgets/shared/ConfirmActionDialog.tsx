'use client';

import { useEffect, useState } from 'react';
import { Dialog } from 'radix-ui';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface ConfirmActionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: React.ReactNode;
  confirmLabel: string;
  /** Destructive styling for the confirm button. */
  destructive?: boolean;
  /** When set, the user must type this exact text to enable the button. */
  requireText?: string;
  onConfirm: () => Promise<void> | void;
}

/**
 * Confirmation for actions with side effects on a monitored host (container
 * stop/restart, model deletion). Stays open while the action runs and shows
 * its error inline instead of an alert().
 */
export function ConfirmActionDialog({
  open, onOpenChange, title, description, confirmLabel, destructive, requireText, onConfirm,
}: ConfirmActionDialogProps) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) { setTyped(''); setError(null); setBusy(false); }
  }, [open]);

  const allowed = !requireText || typed.trim() === requireText;

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={v => { if (!busy) onOpenChange(v); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content
          className="fixed inset-x-3 bottom-3 z-50 rounded-xl border border-gray-200 bg-white p-5 shadow-xl outline-none dark:border-gray-700 dark:bg-gray-900 sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:w-full sm:max-w-md sm:-translate-x-1/2 sm:-translate-y-1/2"
          onEscapeKeyDown={e => { if (busy) e.preventDefault(); }}
        >
          <div className="flex gap-3">
            {destructive && <AlertTriangle className="mt-0.5 size-5 shrink-0 text-red-500" aria-hidden />}
            <div className="min-w-0 flex-1">
              <Dialog.Title className="text-base font-semibold">{title}</Dialog.Title>
              <Dialog.Description asChild>
                <div className="mt-1 break-words text-sm text-gray-600 dark:text-gray-400">{description}</div>
              </Dialog.Description>
            </div>
          </div>
          {requireText && (
            <label className="mt-4 block text-sm">
              <span className="text-gray-600 dark:text-gray-400">Type <code className="rounded bg-gray-100 px-1 font-mono dark:bg-gray-800">{requireText}</code> to confirm</span>
              <input
                autoFocus
                value={typed}
                onChange={e => setTyped(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && allowed && !busy) run(); }}
                className="mt-1 w-full rounded-md border border-gray-300 bg-transparent px-2 py-1.5 font-mono text-sm outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-600"
                aria-label="Confirmation text"
              />
            </label>
          )}
          {error && <p role="alert" className="mt-3 rounded-md bg-red-50 px-2 py-1.5 text-sm text-red-700 dark:bg-red-950/50 dark:text-red-300">{error}</p>}
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
            <Button
              variant={destructive ? 'destructive' : 'default'}
              onClick={run}
              disabled={!allowed || busy}
            >
              {busy && <Loader2 className="animate-spin" aria-hidden />}
              {confirmLabel}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** POST/DELETE JSON and throw the API's error message on failure. */
export async function apiAction(fetcher: (url: string, init?: RequestInit) => Promise<Response>, url: string, method: string, body?: unknown) {
  const res = await fetcher(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: { data?: unknown; error?: { message?: string } } = {};
  try { json = await res.json(); } catch { /* empty body */ }
  if (!res.ok || json.error) throw new Error(json.error?.message || `Request failed (HTTP ${res.status})`);
  return json.data;
}
