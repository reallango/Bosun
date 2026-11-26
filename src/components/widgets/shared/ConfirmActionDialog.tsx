'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

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
  /** The caller is already running the action (for example a delete from a list). */
  busy?: boolean;
  onConfirm: () => Promise<void> | void;
}

/**
 * The one confirmation dialog: actions with side effects on a monitored host
 * (container stop/restart, model deletion), and the Remove/Delete actions
 * around the app. It stays open while the action runs and shows its error
 * inline instead of an alert().
 */
export function ConfirmActionDialog({
  open, onOpenChange, title, description, confirmLabel, destructive, requireText, busy, onConfirm,
}: ConfirmActionDialogProps) {
  const [typed, setTyped] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const working = !!busy || running;

  useEffect(() => {
    if (open) { setTyped(''); setError(null); setRunning(false); }
  }, [open]);

  const allowed = !requireText || typed.trim() === requireText;

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={value => { if (!working) onOpenChange(value); }}>
      <DialogContent
        size="md"
        role="alertdialog"
        onEscapeKeyDown={event => { if (working) event.preventDefault(); }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-start gap-2">
            {destructive && <AlertTriangle className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden />}
            <span className="min-w-0">{title}</span>
          </DialogTitle>
          <DialogDescription asChild>
            <div className="break-words">{description}</div>
          </DialogDescription>
        </DialogHeader>
        {(requireText || error) && (
          <DialogBody className="space-y-3">
            {requireText && (
              <label className="block space-y-1 text-sm">
                <span className="text-muted-foreground">
                  Type <code className="rounded bg-muted px-1 font-mono text-foreground">{requireText}</code> to confirm
                </span>
                <Input
                  autoFocus
                  value={typed}
                  onChange={event => setTyped(event.target.value)}
                  onKeyDown={event => { if (event.key === 'Enter' && allowed && !working) void run(); }}
                  className="font-mono"
                  aria-label="Confirmation text"
                />
              </label>
            )}
            {error && (
              <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-sm text-destructive">
                {error}
              </p>
            )}
          </DialogBody>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={working}>Cancel</Button>
          <Button
            variant={destructive ? 'destructive' : 'default'}
            onClick={run}
            disabled={!allowed || working}
          >
            {working && <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden />}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
