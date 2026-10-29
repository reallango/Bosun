'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';

export interface LeftoverKey { fingerprint: string; comment: string }

export interface ProvisionCreds {
  hostname: string;
  port: number;
  admin_username: string;
  admin_password: string;
  platform: string;
  service_account: string;
}

/**
 * After provisioning: keys on the host that look like an earlier Bosun's (`...-<account>`) but are not
 * labeled for this host. Nothing is selected by default; the person ticks the ones to remove, or keeps them all.
 * The login is held in memory by the parent only for this, and is never stored.
 */
export function LeftoverKeysPanel({ creds, keepKeyId, initial }: { creds: ProvisionCreds | null; keepKeyId: string; initial: LeftoverKey[] }) {
  const [leftover, setLeftover] = useState<LeftoverKey[]>(initial);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => { setLeftover(initial); setSelected([]); setMessage(''); }, [initial]);

  const remove = async () => {
    if (!creds || selected.length === 0) return;
    setBusy(true);
    setMessage('');
    try {
      const res = await fetchWithAuth('/api/servers/provision/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...creds, keep_key_id: keepKeyId, fingerprints: selected }),
      });
      const json = await res.json();
      if (!res.ok) { setMessage(json.error?.message || 'The keys were not removed'); return; }
      setLeftover(json.data?.remaining || []);
      setSelected([]);
      setMessage(`Removed ${json.data?.removed ?? 0} key${json.data?.removed === 1 ? '' : 's'}. A backup of the file was saved on the host next to it as .bosun-bak.`);
    } catch (err) {
      setMessage(String(err));
    } finally {
      setBusy(false);
    }
  };

  if (leftover.length === 0 && !message) return null;
  return (
    <div className="space-y-3 rounded-md border border-warning/40 bg-warning/5 p-4 text-sm" role="group" aria-label="Other keys on this host">
      {leftover.length > 0 && (
        <>
          <div className="font-medium">Remove other keys that look like an earlier Bosun&apos;s?</div>
          <p className="text-muted-foreground">
            These keys end in <code>-{creds?.service_account}</code> but are not labeled for this host ({creds?.hostname}).
            They may belong to an older Bosun install that still manages it. Removing one cuts off whatever still uses that key.
            Nothing is selected: tick the ones to remove.
          </p>
          <ul className="space-y-1.5">
            {leftover.map(k => (
              <li key={k.fingerprint}>
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={selected.includes(k.fingerprint)}
                    onChange={e => setSelected(s => (e.target.checked ? [...s, k.fingerprint] : s.filter(x => x !== k.fingerprint)))}
                    disabled={busy}
                  />
                  <span className="min-w-0">
                    <span className="block break-all font-medium">{k.comment}</span>
                    <span className="block break-all font-mono text-xs text-muted-foreground">{k.fingerprint}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="destructive" size="sm" onClick={remove} disabled={busy || selected.length === 0}>
              {busy ? 'Removing…' : `Remove selected (${selected.length})`}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => { setLeftover([]); setSelected([]); setMessage('Kept all other keys.'); }} disabled={busy}>
              Keep them
            </Button>
          </div>
        </>
      )}
      {message && <p role="status" className="text-muted-foreground">{message}</p>}
    </div>
  );
}
