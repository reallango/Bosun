'use client';

import { useState } from 'react';
import { Copy, Network, PlusCircle, Unplug } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useToast } from '@/components/ui/toast';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import { readJson } from '@/lib/api/readJson';

export interface ClusterConfig {
  node_id: string;
  adv_host: string;
  cluster_ready: boolean;
  suggested_adv_host: string | null;
  secrets: { master_key: 'env' | 'file' | 'none'; auth_secret: 'env' | 'file' | 'none' };
}

type ApiResult<T> = { data?: T; error?: { message?: string } };

/** POST /api/cluster/actions; throws with the server's message. */
export async function clusterAction<T = unknown>(body: Record<string, unknown>): Promise<T> {
  const res = await fetchWithAuth('/api/cluster/actions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, confirm: true }),
  });
  const j = await readJson<ApiResult<T>>(res).catch(() => ({} as ApiResult<T>));
  if (!res.ok) throw new Error(j.error?.message || `Request failed (${res.status})`);
  return j.data as T;
}

/** Wait until this node's database answers again after an rqlite restart. */
export async function waitForDatabase(timeoutMs = 90_000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  await new Promise(r => setTimeout(r, 3000));
  while (Date.now() < end) {
    try {
      const res = await fetch('/api/health', { cache: 'no-store' });
      const j = await res.json();
      if (j?.status === 'ok') return true;
    } catch { /* restarting */ }
    await new Promise(r => setTimeout(r, 2000));
  }
  return false;
}

const PORTS_NOTE = 'Every node must reach the others on ports 4001 (database API) and 4002 (Raft). Publish them from the container and allow them only between the cluster machines: they are not password-protected.';

export function ClusterActions({ cfg, voters, onChanged, onRestarting }: {
  cfg: ClusterConfig;
  voters: number;
  onChanged: () => void;
  onRestarting: (busy: boolean) => void;
}) {
  const { toast } = useToast();
  const [enableOpen, setEnableOpen] = useState(false);
  const [advHost, setAdvHost] = useState(cfg.suggested_adv_host || '');
  const [nodeId, setNodeId] = useState(cfg.node_id);
  const [busy, setBusy] = useState(false);
  const [join, setJoin] = useState<{ code: string; expires_at: string } | null>(null);
  const [singleOpen, setSingleOpen] = useState(false);

  const fail = (title: string, err: unknown) =>
    toast(title, { variant: 'error', description: err instanceof Error ? err.message : undefined });

  const restartFlow = async (doneMsg: string) => {
    onRestarting(true);
    const back = await waitForDatabase();
    onRestarting(false);
    if (back) toast(doneMsg, { variant: 'success' });
    else toast('The database has not come back yet', { variant: 'error', description: 'Check the container logs (rqlite service).' });
    onChanged();
  };

  const enable = async () => {
    setBusy(true);
    try {
      await clusterAction({ action: 'enable', adv_host: advHost.trim(), node_id: nodeId.trim() || undefined });
      setEnableOpen(false);
      await restartFlow('Clustering enabled');
    } catch (err) {
      fail('Could not enable clustering', err);
    } finally {
      setBusy(false);
    }
  };

  const makeCode = async () => {
    setBusy(true);
    try {
      setJoin(await clusterAction<{ code: string; expires_at: string }>({ action: 'join_code' }));
    } catch (err) {
      fail('Could not create a join code', err);
    } finally {
      setBusy(false);
    }
  };

  const toSingle = async () => {
    setBusy(true);
    try {
      const r = await clusterAction<{ method: string; removed: string[]; restarting: boolean }>({ action: 'to_single' });
      setSingleOpen(false);
      if (r.restarting) await restartFlow('This node is now a single-node deployment');
      else {
        toast('This node is now a single-node deployment', { variant: 'success', description: r.removed.length ? `Removed ${r.removed.join(', ')}` : undefined });
        onChanged();
      }
    } catch (err) {
      fail('Could not convert to single node', err);
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!join) return;
    try {
      await navigator.clipboard.writeText(join.code);
      toast('Join code copied', { variant: 'success' });
    } catch {
      toast('Copy failed: select the code and copy it manually', { variant: 'error' });
    }
  };

  return (
    <Card>
      <CardHeader><CardTitle>Manage cluster</CardTitle></CardHeader>
      <CardContent className="space-y-4 text-sm">
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div><dt className="text-muted-foreground">Node name</dt><dd className="font-mono">{cfg.node_id}</dd></div>
          <div><dt className="text-muted-foreground">Advertised address</dt><dd className="font-mono">{cfg.adv_host}</dd></div>
          <div><dt className="text-muted-foreground">Mode</dt><dd>{voters > 1 ? `Cluster (${voters} nodes)` : cfg.cluster_ready ? 'Single node, ready to add nodes' : 'Single node'}</dd></div>
        </dl>

        {!cfg.cluster_ready && (
          <div className="space-y-2 rounded-lg border p-3">
            <p className="font-medium">Switch to multi-node</p>
            <p className="text-muted-foreground">
              This node only advertises a local address, so no other node can join it. Enabling clustering sets the address other nodes use to reach it and restarts the database (a few seconds; data is kept).
            </p>
            <Button size="sm" onClick={() => setEnableOpen(true)}><Network /> Enable clustering</Button>
          </div>
        )}

        {cfg.cluster_ready && (
          <div className="space-y-2 rounded-lg border p-3">
            <p className="font-medium">Add a node</p>
            <p className="text-muted-foreground">
              Start Bosun on the new machine, open its setup page, choose <em>Join an existing cluster</em> and paste this code. The new node takes over this cluster&apos;s users and settings; its own empty database is discarded.
            </p>
            <p className="text-xs text-muted-foreground">{PORTS_NOTE}</p>
            {!join ? (
              <Button size="sm" onClick={makeCode} disabled={busy}><PlusCircle /> Create join code</Button>
            ) : (
              <div className="space-y-2">
                <textarea
                  readOnly
                  value={join.code}
                  onFocus={e => e.currentTarget.select()}
                  className="h-24 w-full resize-none rounded-md border bg-muted/40 p-2 font-mono text-xs break-all"
                  aria-label="Join code"
                />
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" onClick={copy}><Copy /> Copy</Button>
                  <Button size="sm" variant="outline" onClick={() => setJoin(null)}>Hide</Button>
                  <span className="text-xs text-muted-foreground">Valid until {new Date(join.expires_at).toLocaleString()}.</span>
                </div>
                <p className="text-xs text-destructive">
                  The code contains this cluster&apos;s encryption keys. Treat it like a password and only paste it into a Bosun node you control.
                </p>
              </div>
            )}
          </div>
        )}

        {voters > 1 && (
          <div className="space-y-2 rounded-lg border border-destructive/30 p-3">
            <p className="font-medium">Convert to single node</p>
            <p className="text-muted-foreground">
              Removes every other node from the cluster and keeps this one with all data. Use it to decommission a cluster, or on the last surviving node when the others are gone for good.
            </p>
            <Button size="sm" variant="destructive" onClick={() => setSingleOpen(true)} disabled={busy}><Unplug /> Convert to single node</Button>
          </div>
        )}
      </CardContent>

      <Dialog open={enableOpen} onOpenChange={o => !busy && setEnableOpen(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Enable clustering</DialogTitle>
            <DialogDescription>The database on this node restarts with the new address. Data is kept.</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-3 text-sm">
            <div className="space-y-1.5">
              <Label htmlFor="adv-host">Address of this machine</Label>
              <Input id="adv-host" value={advHost} onChange={e => setAdvHost(e.target.value)} placeholder="192.168.1.20 or bosun1.lan" />
              <p className="text-xs text-muted-foreground">LAN IP or DNS name the other nodes can reach. Not localhost.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="node-id">Node name</Label>
              <Input id="node-id" value={nodeId} onChange={e => setNodeId(e.target.value)} />
            </div>
            <p className="text-xs text-muted-foreground">{PORTS_NOTE}</p>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEnableOpen(false)} disabled={busy}>Cancel</Button>
            <Button onClick={enable} disabled={busy || !advHost.trim()}>{busy ? 'Restarting…' : 'Enable and restart database'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={singleOpen} onOpenChange={o => !busy && setSingleOpen(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Convert to single node?</DialogTitle>
            <DialogDescription>
              All other nodes are removed from the cluster. They stop receiving data; reset them before using them again. If the cluster has no majority right now, this node&apos;s database restarts as a one-node cluster with its last replicated data.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSingleOpen(false)} disabled={busy}>Cancel</Button>
            <Button variant="destructive" onClick={toSingle} disabled={busy}>{busy ? 'Working…' : 'Convert'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
