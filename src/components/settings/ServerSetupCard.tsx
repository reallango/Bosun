'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/components/ui/toast';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import { readJson } from '@/lib/api/readJson';
import { ConfirmActionDialog } from '@/components/widgets/shared/ConfirmActionDialog';

interface SetupItem {
  widget_type: string; label: string; description: string | null;
  installed: boolean | null; running: boolean | null; version: string | null; supported: boolean | null;
  system: string | null; note: string | null; error: string | null;
  install: { action_id: string; label: string; allowed: boolean; confirm: { title?: string; text?: string } | null };
}
interface Deploy {
  mode: 'join' | 'standalone'; node_name: string; image: string; web: string;
  status: 'running' | 'done' | 'failed'; step: string; message: string | null; started_by: string; started_at: string;
}
type Running = { kind: 'node'; node: string; self: boolean; web: string | null } | { kind: 'stack'; name: string };
type Pending = { title: string; body: React.ReactNode; label: string; run: () => Promise<void> };

async function call<T>(url: string, init?: RequestInit): Promise<{ ok: boolean; data?: T; error?: string }> {
  const res = await fetchWithAuth(url, init);
  const json = await readJson<{ data?: T; error?: { message?: string } }>(res);
  return res.ok ? { ok: true, data: json.data } : { ok: false, error: json.error?.message || `HTTP ${res.status}` };
}
const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/**
 * "Set up this server": software installed widgets can put on the host (Docker, ...), and deploying Bosun itself
 * to it (joining this cluster, or standalone). Full access only (the page is admin-only).
 */
export function ServerSetupCard({ serverId }: { serverId: string }) {
  const { toast } = useToast();
  const [setups, setSetups] = useState<SetupItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [deploy, setDeploy] = useState<Deploy | null>(null);
  const [running, setRunning] = useState<Running | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [defaults, setDefaults] = useState<{ node_name: string; cluster: boolean } | null>(null);
  const [mode, setMode] = useState<'join' | 'standalone'>('join');
  const [nodeName, setNodeName] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadSetups = useCallback(async () => {
    const r = await call<{ setups: SetupItem[] }>(`/api/servers/${serverId}/setup`);
    if (r.ok) { setSetups(r.data!.setups); setError(null); } else { setSetups([]); setError(r.error ?? null); }
  }, [serverId]);

  const loadDeploy = useCallback(async () => {
    const r = await call<{ deploy: Deploy | null; running: Running | null; check_error: string | null; defaults: { node_name: string; cluster: boolean } }>(`/api/servers/${serverId}/bosun`);
    if (!r.ok) return;
    setDeploy(r.data!.deploy);
    setRunning(r.data!.running);
    setCheckError(r.data!.check_error);
    setDefaults(d => d ?? r.data!.defaults);
    if (!r.data!.defaults.cluster) setMode('standalone');
    if (r.data!.deploy?.status === 'running') timer.current = setTimeout(loadDeploy, 5000);
    else if (r.data!.deploy) loadSetups();
  }, [serverId, loadSetups]);

  useEffect(() => {
    loadSetups(); loadDeploy();
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [loadSetups, loadDeploy]);

  const followJob = async (jobId: string) => {
    for (;;) {
      await new Promise(r => setTimeout(r, 3000));
      const r = await call<{ task: { status: string; message: string | null; steps?: string[] } }>(`/api/widget-jobs/${jobId}`);
      if (!r.ok) return { status: 'error', message: r.error ?? null };
      const t = r.data!.task;
      const last = t.steps?.[t.steps.length - 1];
      if (last) setProgress(last);
      if (t.status !== 'running') return t;
    }
  };

  const install = (s: SetupItem) => setPending({
    title: s.install.confirm?.title || `${s.install.label}?`,
    body: <p>{s.install.confirm?.text || `Runs "${s.install.label}" on this server.`}</p>,
    label: s.install.label,
    run: async () => {
      const r = await call<{ jobId?: string; message?: string; success?: boolean }>(
        `/api/servers/${serverId}/widget-actions/${encodeURIComponent(s.widget_type)}/${encodeURIComponent(s.install.action_id)}`, post({ params: {}, confirm: true }));
      if (!r.ok) throw new Error(r.error ?? 'Refused');
      setInstalling(s.widget_type); setProgress('Starting…');
      void (async () => {
        const t = r.data?.jobId ? await followJob(r.data.jobId) : { status: r.data?.success === false ? 'error' : 'success', message: r.data?.message ?? null };
        setInstalling(null); setProgress(null);
        toast(t.status === 'success' ? `${s.label}: ${t.message ?? 'installed'}` : `${s.label}: ${t.message ?? 'failed'}`, { variant: t.status === 'success' ? 'success' : 'error' });
        loadSetups();
      })();
    },
  });

  const startDeploy = () => {
    const name = (nodeName || defaults?.node_name || '').trim();
    setPending({
      title: mode === 'join' ? `Deploy Bosun here and join it as ${name}?` : 'Deploy a standalone Bosun here?',
      body: (
        <ul className="mt-2 list-disc space-y-1.5 pl-5">
          <li>Bosun runs here as the stack <code>bosun</code> from the published image (Settings &gt; Updates: image and channel), so it updates itself like the other nodes.</li>
          <li>Port 3042 must be free on the server{mode === 'join' ? ', and 4001 and 4002 too: they must be reachable between the nodes (keep them off the internet)' : ''}.</li>
          {mode === 'join'
            ? <li>It joins this cluster with a one-time join code: users, servers and settings come from the cluster, and it can take over polling when this node is down.</li>
            : <li>It is a separate Bosun with its own data: open it afterwards to create its admin account.</li>}
        </ul>
      ),
      label: 'Deploy Bosun',
      run: async () => {
        const r = await call<{ deploy: Deploy }>(`/api/servers/${serverId}/bosun`, post({ mode, node_name: name || undefined, confirm: true }));
        if (!r.ok) throw new Error(r.error ?? 'Refused');
        setDeploy(r.data!.deploy);
        timer.current = setTimeout(loadDeploy, 5000);
      },
    });
  };

  const docker = setups?.find(s => s.installed && s.running);
  return (
    <Card>
      <CardHeader><CardTitle>Set up this server</CardTitle></CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">Software your installed widgets can put on this host.</p>
          {error && <p className="text-xs text-destructive">{error}</p>}
          {setups === null ? <p className="text-xs text-muted-foreground">Checking…</p> : setups.length === 0 ? (
            <p className="text-xs text-muted-foreground">No installed widget offers anything to install.</p>
          ) : setups.map(s => (
            <div key={s.widget_type} className="flex flex-wrap items-center gap-2 rounded-md border p-3 text-sm">
              <div className="min-w-0 flex-1">
                <div className="font-medium">{s.label}</div>
                <div className="text-xs text-muted-foreground">
                  {s.error ? `Could not check: ${s.error}`
                    : s.installed ? `${s.running ? 'Installed and running' : 'Installed, not running'}${s.version ? ` (${s.version})` : ''}`
                    : `Not installed${s.system ? ` on ${s.system}` : ''}`}
                  {s.note ? ` · ${s.note}` : ''}
                </div>
                {s.description && <div className="text-xs text-muted-foreground">{s.description}</div>}
              </div>
              {installing === s.widget_type ? <span className="text-xs text-muted-foreground">{progress}</span>
                : !(s.installed && s.running) && s.install.allowed && s.supported !== false && (
                  <Button size="sm" variant="outline" onClick={() => install(s)} disabled={installing !== null}>{s.install.label}</Button>
                )}
            </div>
          ))}
        </div>

        <div className="space-y-2">
          <span className="text-sm font-medium">Bosun on this server</span>
          {deploy && (
            <p className={`rounded-md px-2 py-1.5 text-xs ${deploy.status === 'failed' ? 'bg-red-50 text-red-700 dark:bg-red-950/50 dark:text-red-300' : 'bg-muted text-muted-foreground'}`}>
              {deploy.status === 'running' ? `${deploy.step}…` : deploy.message}
              {deploy.status === 'done' && deploy.mode === 'standalone' && <> <a className="underline" href={deploy.web} target="_blank" rel="noreferrer">Open it</a></>}
            </p>
          )}
          {running && (
            <div className="rounded-md bg-muted px-2 py-1.5 text-xs text-muted-foreground">
              {running.kind === 'node' ? (
                <>
                  <p>This server runs Bosun node <code>{running.node}</code> of this cluster{running.self ? ' (this one)' : ''}.</p>
                  <p className="mt-1">
                    <Link className="underline" href="/settings/cluster">Settings → Cluster</Link>
                    {' · '}
                    <Link className="underline" href="/settings/updates">Settings → Updates</Link>
                  </p>
                </>
              ) : (
                <p>
                  Bosun already runs here (stack <code>{running.name}</code>).
                  {deploy?.web && <> <a className="underline" href={deploy.web} target="_blank" rel="noreferrer">Open it</a></>}
                </p>
              )}
            </div>
          )}
          {!running && deploy?.status !== 'running' && deploy?.status !== 'done' && (
            <>
              {!docker && <p className="text-xs text-muted-foreground">Needs Docker on this server first (above).</p>}
              <div className="flex flex-wrap items-end gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="bosun-mode">Mode</Label>
                  <select id="bosun-mode" className="form-select !h-9 !w-auto text-sm" value={mode} onChange={e => setMode(e.target.value as 'join' | 'standalone')}>
                    <option value="join" disabled={defaults?.cluster === false}>Join this cluster (new node)</option>
                    <option value="standalone">Standalone (its own Bosun)</option>
                  </select>
                </div>
                {mode === 'join' && (
                  <div className="space-y-1.5">
                    <Label htmlFor="bosun-node">Node name</Label>
                    <Input id="bosun-node" className="!h-9 w-44" value={nodeName} placeholder={defaults?.node_name} onChange={e => setNodeName(e.target.value)} />
                  </div>
                )}
                <Button size="sm" onClick={startDeploy} disabled={!docker}>Deploy Bosun</Button>
              </div>
              {defaults?.cluster === false && <p className="text-xs text-muted-foreground">Joining needs clustering enabled on this Bosun (Settings &gt; Cluster).</p>}
            </>
          )}
          {!running && checkError && (
            <p className="text-xs text-muted-foreground">Could not check whether Bosun already runs here: {checkError}</p>
          )}
        </div>
      </CardContent>
      <ConfirmActionDialog
        open={pending !== null}
        onOpenChange={o => { if (!o) setPending(null); }}
        title={pending?.title ?? ''}
        description={pending?.body}
        confirmLabel={pending?.label ?? 'OK'}
        onConfirm={async () => { await pending?.run(); }}
      />
    </Card>
  );
}
