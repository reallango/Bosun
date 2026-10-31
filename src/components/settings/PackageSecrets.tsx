'use client';

import { useCallback, useEffect, useState } from 'react';
import { Check, KeyRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import { readJson } from '@/lib/api/readJson';

interface SecretRow { id: string; label: string; description: string; set: boolean }

/**
 * The secrets a widget package declares (a token for a private repository, for example). An admin sets or removes each one here;
 * the value is stored encrypted, handed only to the scripts of the package that name it, and never shown again.
 */
export default function PackageSecrets({ packageId }: { packageId: string }) {
  const { toast } = useToast();
  const [rows, setRows] = useState<SecretRow[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetchWithAuth(`/api/widget-packages/${encodeURIComponent(packageId)}/secrets`);
      const json = await readJson<{ data?: { secrets: SecretRow[] }; error?: { message?: string } }>(res);
      if (!res.ok || !json.data) throw new Error(json.error?.message || `HTTP ${res.status}`);
      setRows(json.data.secrets);
    } catch (err) {
      toast('Could not load the secrets', { variant: 'error', description: err instanceof Error ? err.message : undefined });
    }
  }, [packageId, toast]);
  useEffect(() => { void load(); }, [load]);

  const call = async (id: string, method: 'PUT' | 'DELETE', value?: string) => {
    setBusy(id);
    try {
      const res = await fetchWithAuth(`/api/widget-packages/${encodeURIComponent(packageId)}/secrets${method === 'DELETE' ? `?id=${encodeURIComponent(id)}` : ''}`, {
        method, ...(method === 'PUT' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, value }) } : {}),
      });
      const json = await readJson<{ error?: { message?: string } }>(res);
      if (!res.ok || json.error) throw new Error(json.error?.message || `HTTP ${res.status}`);
      setDrafts(d => ({ ...d, [id]: '' }));
      await load();
    } catch (err) {
      toast(method === 'PUT' ? 'Could not save the secret' : 'Could not remove the secret', { variant: 'error', description: err instanceof Error ? err.message : undefined });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mt-2 space-y-3 rounded-lg bg-muted/50 p-3 text-sm">
      {rows.map(r => (
        <div key={r.id} className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <KeyRound className="size-3.5 text-muted-foreground" aria-hidden />
            <span className="font-medium">{r.label}</span>
            {r.set
              ? <span className="inline-flex items-center gap-1 rounded bg-green-500/15 px-1 text-[10px] uppercase text-green-700 dark:text-green-400"><Check className="size-3" aria-hidden /> set</span>
              : <span className="rounded bg-muted px-1 text-[10px] uppercase text-muted-foreground">not set</span>}
          </div>
          {r.description && <p className="text-xs text-muted-foreground">{r.description}</p>}
          <div className="flex flex-wrap items-center gap-2">
            <Input type="password" autoComplete="off" className="h-8 max-w-xs flex-1" placeholder={r.set ? 'Enter a new value to replace it' : 'Value'} aria-label={`${r.label} value`}
              value={drafts[r.id] ?? ''} onChange={e => setDrafts(d => ({ ...d, [r.id]: e.target.value }))} disabled={busy !== null} />
            <Button size="sm" disabled={busy !== null || !(drafts[r.id] ?? '').trim()} onClick={() => call(r.id, 'PUT', (drafts[r.id] ?? '').trim())}>{r.set ? 'Replace' : 'Save'}</Button>
            {r.set && <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => call(r.id, 'DELETE')}>Remove</Button>}
          </div>
        </div>
      ))}
      <p className="text-xs text-muted-foreground">Stored encrypted. Only the package&apos;s own scripts that name a secret receive it, and it is never shown again.</p>
    </div>
  );
}
