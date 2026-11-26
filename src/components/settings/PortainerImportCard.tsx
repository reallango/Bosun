'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/components/ui/toast';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import { readJson } from '@/lib/api/readJson';

interface Candidate {
  name: string;
  containers: { name: string; service: string; state: string }[];
  running: boolean;
  own: boolean;
  portainer: { id: number; git: { repo: string; branch: string; file: string } | null } | null;
  from: Array<'portainer' | 'containers'>;
  importable: boolean;
  reason: string | null;
}

type Choice = { from: 'portainer' | 'containers'; detach: boolean };

async function call<T>(url: string, init?: RequestInit): Promise<{ ok: boolean; data?: T; error?: string }> {
  const res = await fetchWithAuth(url, init);
  const json = await readJson<{ data?: T; error?: { message?: string } }>(res);
  return res.ok ? { ok: true, data: json.data } : { ok: false, error: json.error?.message || `HTTP ${res.status}` };
}

/**
 * Import stacks another tool (Portainer) created on this server into Bosun. Full access only (the page is admin-only).
 * Portainer cannot forget a stack without stopping it, so "Detach" is per stack: Bosun brings the stack straight back up.
 */
export function PortainerImportCard({ serverId }: { serverId: string }) {
  const { toast } = useToast();
  const [conn, setConn] = useState<{ url: string; insecure: boolean; endpoint_id: number | null; has_key: boolean } | null>(null);
  const [url, setUrl] = useState('');
  const [key, setKey] = useState('');
  const [insecure, setInsecure] = useState(true);
  const [endpoints, setEndpoints] = useState<{ Id: number; Name: string }[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [perror, setPerror] = useState<string | null>(null);
  const [choice, setChoice] = useState<Record<string, Choice>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const loadStacks = useCallback(async () => {
    const r = await call<{ candidates: Candidate[]; portainer: { configured: boolean; error: string | null } }>(`/api/servers/${serverId}/portainer/stacks`);
    if (!r.ok) { setCandidates([]); setPerror(r.error ?? null); return; }
    setCandidates(r.data!.candidates);
    setPerror(r.data!.portainer.error);
    setChoice(prev => Object.fromEntries(r.data!.candidates.map(c => [c.name, prev[c.name] ?? { from: c.from[0] ?? 'containers', detach: false }])));
  }, [serverId]);

  useEffect(() => {
    (async () => {
      const r = await call<{ portainer: typeof conn }>(`/api/servers/${serverId}/portainer`);
      if (r.ok && r.data?.portainer) { setConn(r.data.portainer); setUrl(r.data.portainer.url); setInsecure(r.data.portainer.insecure); }
      await loadStacks();
    })();
  }, [serverId, loadStacks]);

  const save = async (endpointId?: number) => {
    setSaving(true); setError(null);
    const r = await call<{ portainer: NonNullable<typeof conn>; endpoints: { Id: number; Name: string }[] }>(`/api/servers/${serverId}/portainer`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, api_key: key || undefined, insecure, ...(endpointId !== undefined ? { endpoint_id: endpointId } : {}) }),
    });
    setSaving(false);
    if (!r.ok) { setError(r.error ?? 'Could not connect'); return; }
    setConn(r.data!.portainer); setKey(''); setEndpoints(r.data!.endpoints);
    toast(r.data!.portainer.endpoint_id === null && r.data!.endpoints.length > 1 ? 'Connected: choose the environment of this server' : 'Connected to Portainer', { variant: 'success' });
    await loadStacks();
  };

  const runImport = async (c: Candidate) => {
    const ch = choice[c.name];
    setBusy(c.name);
    const r = await call<{ jobId: string | null; notes: string[] }>(`/api/servers/${serverId}/portainer/import`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: c.name, from: ch.from, detach: ch.detach }),
    });
    setBusy(null);
    if (!r.ok) { toast(r.error ?? 'Import failed', { variant: 'error' }); return; }
    toast(`Importing ${c.name}: follow it in the bell (the result appears there)`, { variant: 'success' });
    setTimeout(loadStacks, 5000);
  };

  return (
    <Card>
      <CardHeader><CardTitle>Import stacks (Portainer)</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          Stacks that another tool started on this server can become Bosun stacks under the same name, so their volumes (data) are kept.
          Importing restarts the stack once (its containers are re-created from Bosun&apos;s copy). With Portainer&apos;s address and an API key (Portainer: My account &gt; Access tokens) Bosun copies the exact compose file,
          variables and git settings; otherwise it rebuilds the compose file from the running containers.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="pt-url">Portainer address</Label>
            <Input id="pt-url" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://192.168.1.160:9443" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pt-key">API key {conn?.has_key && <span className="text-muted-foreground">(stored; leave empty to keep)</span>}</Label>
            <Input id="pt-key" type="password" autoComplete="off" value={key} onChange={e => setKey(e.target.value)} placeholder="ptr_..." />
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={insecure} onChange={e => setInsecure(e.target.checked)} />
          Accept a self-signed certificate (Portainer&apos;s default)
        </label>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={() => save()} disabled={saving || !url}>{saving ? 'Connecting…' : conn ? 'Save and test' : 'Connect'}</Button>
          {conn && <span className="text-xs text-muted-foreground">Connected to {conn.url}{conn.endpoint_id !== null ? ` (environment ${conn.endpoint_id})` : ''}</span>}
          {endpoints.length > 1 && (
            <select aria-label="Portainer environment of this server" className="form-select !h-8 !w-auto text-xs" value={conn?.endpoint_id ?? ''} onChange={e => save(Number(e.target.value))}>
              <option value="" disabled>Choose the environment of this server…</option>
              {endpoints.map(ep => <option key={ep.Id} value={ep.Id}>{ep.Name} ({ep.Id})</option>)}
            </select>
          )}
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Stacks Bosun does not manage yet</span>
            <Button size="sm" variant="ghost" onClick={loadStacks}>Refresh</Button>
          </div>
          {perror && <p className="text-xs text-destructive">Portainer: {perror}</p>}
          {candidates === null ? <p className="text-xs text-muted-foreground">Loading…</p> : candidates.length === 0 ? (
            <p className="text-xs text-muted-foreground">None: every stack on this server is already managed by Bosun.</p>
          ) : candidates.map(c => {
            const ch = choice[c.name] ?? { from: c.from[0] ?? 'containers', detach: false };
            return (
              <div key={c.name} className="space-y-2 rounded-md border p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono font-medium">{c.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {c.containers.length} container{c.containers.length === 1 ? '' : 's'}, {c.running ? 'running' : 'stopped'}
                    {c.portainer ? `; in Portainer${c.portainer.git ? ` (git: ${c.portainer.git.repo} ${c.portainer.git.branch})` : ''}` : ''}
                  </span>
                </div>
                {!c.importable ? <p className="text-xs text-muted-foreground">{c.reason}</p> : (
                  <div className="flex flex-wrap items-center gap-3">
                    <select aria-label={`Import ${c.name} from`} className="form-select !h-8 !w-auto text-xs" value={ch.from}
                      onChange={e => setChoice(p => ({ ...p, [c.name]: { ...ch, from: e.target.value as Choice['from'] } }))}>
                      {c.from.includes('portainer') && <option value="portainer">From Portainer (exact file and variables)</option>}
                      {c.from.includes('containers') && <option value="containers">Rebuilt from the containers</option>}
                    </select>
                    {c.portainer && (
                      <label className="flex items-center gap-1.5 text-xs">
                        <input type="checkbox" checked={ch.detach} onChange={e => setChoice(p => ({ ...p, [c.name]: { ...ch, detach: e.target.checked } }))} />
                        Detach from Portainer {c.running && <span className="text-muted-foreground">(one more short restart: Portainer cannot let go otherwise)</span>}
                      </label>
                    )}
                    <Button size="sm" onClick={() => runImport(c)} disabled={busy !== null}>{busy === c.name ? 'Starting…' : 'Import'}</Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
