'use client';

import { useCallback, useEffect, useState } from 'react';
import { CircleAlert, CircleCheck, Loader2, RefreshCw, Download, RotateCcw } from 'lucide-react';
import { PageHeader } from '@/components/settings/PageHeader';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { LoadingSpinner } from '@/components/shared/LoadingSpinner';
import { ErrorState } from '@/components/shared/ErrorState';
import { AdminOnlyNotice } from '@/components/settings/access-ui';
import { ConfirmActionDialog } from '@/components/widgets/shared/ConfirmActionDialog';
import { useToast } from '@/components/ui/toast';
import { useAuth } from '@/hooks/useAuth';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import { readJson } from '@/lib/api/readJson';
import { hasRole } from '@/lib/auth/levels';
import { formatDistanceToNow } from '@/lib/utils/date';
import { cn } from '@/lib/utils';

interface Status {
  config: { image: string; channel: string; webPort: number };
  running: { commit: string; short: string; channel: string };
  latest: { commit: string | null; checked_at: string; error: string | null } | null;
  nodes: { id: string; leader: boolean; reachable: boolean; healthy: boolean; web: string | null; commit: string | null; channel: string | null; self: boolean; record: { server_id: string | null } | null }[];
  plan: { node: string; server_id: string | null; project: string | null; service: string | null; as: string | null }[];
  problems: string[];
  previous: string | null;
  rollout: {
    kind: 'update' | 'rollback'; target: string; from: string | null; image: string; started_by: string; started_at: string;
    finished_at: string | null; status: string; backup: string | null;
    steps: { node: string; self: boolean; status: string; message: string | null }[];
  } | null;
}

const short = (c: string | null | undefined) => (c && c !== 'unknown' ? c.slice(0, 7) : 'unknown');
const same = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a !== 'unknown' && (a.startsWith(b.slice(0, 7)) || b.startsWith(a.slice(0, 7)));

export default function UpdatesPage() {
  const { user } = useAuth();
  const isAdmin = hasRole(user?.role, 'admin');
  const { toast } = useToast();
  const [s, setS] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState({ channel: '', image: '', webPort: '' });
  const [confirm, setConfirm] = useState(false);
  const [confirmRollback, setConfirmRollback] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetchWithAuth('/api/system/update');
      const json = await readJson<{ data?: Status; error?: { message?: string } }>(res);
      if (!res.ok || !json.data) { setError(json.error?.message || `HTTP ${res.status}`); return; }
      setS(json.data); setError(null);
      setForm(f => (f.channel ? f : { channel: json.data!.config.channel, image: json.data!.config.image, webPort: String(json.data!.config.webPort) }));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, []);

  useEffect(() => { if (isAdmin) void load(); }, [isAdmin, load]);
  // While an update runs, follow it.
  useEffect(() => {
    if (s?.rollout?.status !== 'running') return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [s?.rollout?.status, load]);

  const post = async (body: unknown, label: string, rethrow = false) => {
    setBusy(label);
    try {
      const res = await fetchWithAuth('/api/system/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const json = await readJson<{ error?: { message?: string } }>(res);
      if (!res.ok) {
        const message = json.error?.message || `HTTP ${res.status}`;
        toast(message, { variant: 'error' });
        if (rethrow) throw new Error(message);
      }
      await load();
    } finally { setBusy(null); }
  };
  const saveConfig = async () => {
    setBusy('save');
    try {
      const res = await fetchWithAuth('/api/system/update', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel: form.channel, image: form.image, web_port: Number(form.webPort) }) });
      const json = await readJson<{ error?: { message?: string } }>(res);
      if (!res.ok) toast(json.error?.message || `HTTP ${res.status}`, { variant: 'error' });
      else { toast('Saved', { variant: 'success' }); await post({ action: 'check' }, 'check'); }
    } finally { setBusy(null); }
  };

  if (!isAdmin && user) return (<><PageHeader title="Updates" /><div><AdminOnlyNotice /></div></>);

  const latest = s?.latest?.commit ?? null;
  const behind = s ? s.nodes.filter(n => latest && !same(n.commit, latest)) : [];
  const running = s?.rollout?.status === 'running';
  const previous = s?.previous ?? null;
  const rollback = s?.rollout?.kind === 'rollback';

  return (
    <>
      <PageHeader title="Updates" description="Bosun version on each node." />
      <div className="space-y-4">
        {!s ? (error ? <ErrorState message={error} onRetry={load} /> : <LoadingSpinner />) : (
          <>
            <Card>
              <CardHeader><CardTitle>Bosun version</CardTitle></CardHeader>
              <CardContent className="space-y-3 text-sm">
                <p>This node runs <span className="font-mono">{short(s.running.commit)}</span> ({s.running.channel}).
                  {' '}Newest image for <span className="font-mono">{s.config.channel}</span>:{' '}
                  {latest ? <span className="font-mono">{short(latest)}</span> : <span className="text-muted-foreground">{s.latest?.error ?? 'not checked yet'}</span>}
                  {s.latest && <span className="text-muted-foreground"> (checked {formatDistanceToNow(new Date(s.latest.checked_at))})</span>}
                </p>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="text-muted-foreground"><tr><th className="py-1 pr-3">Node</th><th className="pr-3">Runs</th><th className="pr-3">State</th><th className="pr-3">Bosun stack</th></tr></thead>
                    <tbody>
                      {s.nodes.map(n => {
                        const p = s.plan.find(x => x.node === n.id);
                        return (
                          <tr key={n.id} className="border-t">
                            <td className="py-1 pr-3 font-medium">{n.id}{n.self ? ' (this node)' : ''}{n.leader ? ' · leader' : ''}</td>
                            <td className="pr-3 font-mono">{short(n.commit)}{latest && (same(n.commit, latest) ? <CircleCheck className="ml-1 inline size-3 text-success" aria-label="up to date" /> : <span className="ml-1 text-warning">update available</span>)}</td>
                            <td className="pr-3">{n.healthy && n.reachable ? 'running' : 'not reachable'}</td>
                            <td className="pr-3">{p?.project ? <span className="font-mono">{p.project}/{p.service} ({p.as})</span> : <span className="text-muted-foreground">unknown</span>}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {s.problems.length > 0 && (
                  <div className="space-y-1 rounded-md border border-warning/40 bg-warning/10 p-2 text-xs">
                    <div className="font-medium">Before updating:</div>
                    <ul className="list-disc pl-5">{s.problems.map(p => <li key={p}>{p}</li>)}</ul>
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="outline" size="sm" onClick={() => post({ action: 'check' }, 'check')} disabled={busy !== null}><RefreshCw />{busy === 'check' ? 'Checking…' : 'Check now'}</Button>
                  {!confirm ? (
                    <Button size="sm" onClick={() => setConfirm(true)} disabled={busy !== null || running || !latest || behind.length === 0 || s.problems.length > 0}>
                      <Download />Update all nodes to {short(latest)}
                    </Button>
                  ) : (
                    <span className="flex flex-wrap items-center gap-2 rounded-md border p-2 text-xs">
                      The database is backed up, then each node restarts on the new version, one at a time (this node last).
                      <Button size="sm" onClick={() => { setConfirm(false); void post({ action: 'start', confirm: true }, 'start'); }}>Start the update</Button>
                      <Button size="sm" variant="outline" onClick={() => setConfirm(false)}>Cancel</Button>
                    </span>
                  )}
                  {previous && !running && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                      onClick={() => setConfirmRollback(true)}
                      disabled={busy !== null || s.problems.length > 0}
                    >
                      <RotateCcw />Roll back to {short(previous)}
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>

            {s.rollout && (
              <Card>
                <CardHeader>
                  <CardTitle>
                    {rollback
                      ? running ? `Rolling back to ${short(s.rollout.target)}` : s.rollout.status === 'done' ? `Rolled back to ${short(s.rollout.target)}` : `Rollback to ${short(s.rollout.target)} stopped`
                      : running ? 'Updating' : s.rollout.status === 'done' ? 'Last update' : 'Last update (stopped)'}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  <p className="text-xs text-muted-foreground">
                    {s.rollout.from ? <>From <span className="font-mono">{short(s.rollout.from)}</span> to </> : <>To </>}
                    <span className="font-mono">{s.rollout.image}</span>, started by {s.rollout.started_by} {formatDistanceToNow(new Date(s.rollout.started_at))}
                    {s.rollout.backup && <> · database backup: <span className="font-mono">{s.rollout.backup}</span></>}
                  </p>
                  <ul className="space-y-1">
                    {s.rollout.steps.map(st => (
                      <li key={st.node} className="flex items-center gap-2 text-xs">
                        {st.status === 'done' || st.status === 'skipped' ? <CircleCheck className="size-4 text-success" /> : st.status === 'failed' ? <CircleAlert className="size-4 text-destructive" /> : st.status === 'pending' ? <span className="size-4 rounded-full border" /> : <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />}
                        <span className="font-medium">{st.node}{st.self ? ' (this node)' : ''}</span>
                        <span className={cn('text-muted-foreground', st.status === 'failed' && 'text-destructive')}>{st.status === 'restarting' ? 'restarting itself (reload this page in a minute)' : st.status}{st.message ? `: ${st.message}` : ''}</span>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            )}

            <Card>
              <CardHeader><CardTitle>Where updates come from</CardTitle></CardHeader>
              <CardContent className="space-y-3 text-sm">
                <p className="text-xs text-muted-foreground">Images are built by the repository&apos;s image workflow and published for the main and dev branches. Each node&apos;s Bosun stack must be a Bosun stack (imported) so its service can be moved to the new image.</p>
                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="space-y-1.5"><Label htmlFor="u-ch">Channel (branch)</Label><Input id="u-ch" value={form.channel} onChange={e => setForm({ ...form, channel: e.target.value })} placeholder="main" /></div>
                  <div className="space-y-1.5 sm:col-span-2"><Label htmlFor="u-img">Image</Label><Input id="u-img" value={form.image} onChange={e => setForm({ ...form, image: e.target.value })} placeholder="ghcr.io/reallango/bosun" /></div>
                  <div className="space-y-1.5"><Label htmlFor="u-port">Bosun web port on the nodes</Label><Input id="u-port" value={form.webPort} onChange={e => setForm({ ...form, webPort: e.target.value })} placeholder="3042" /></div>
                </div>
                <Button variant="outline" size="sm" onClick={saveConfig} disabled={busy !== null}>Save</Button>
              </CardContent>
            </Card>
          </>
        )}
      </div>

      <ConfirmActionDialog
        open={confirmRollback && !!previous}
        onOpenChange={setConfirmRollback}
        title={`Roll back to ${short(previous)}?`}
        description={
          <>
            Every node goes back to <span className="font-mono">{short(previous)}</span> one at a time (this node last).
            The database is backed up first but is <strong>not</strong> restored: schema changes made by the newer version
            stay. Bosun&apos;s migrations only add, so the older version keeps working, but a rollback across a release
            that changed data may need the backup.
          </>
        }
        confirmLabel={`Roll back to ${short(previous)}`}
        destructive
        onConfirm={async () => { await post({ action: 'rollback', confirm: true }, 'rollback', true); }}
      />
    </>
  );
}
