'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { RefreshCw } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';

interface JoinStatus {
  node_id: string;
  adv_host: string;
  joinable: boolean;
  reason: string | null;
  db_ready: boolean;
  voters: number;
  joined: boolean;
}

async function getStatus(): Promise<JoinStatus | null> {
  try {
    const res = await fetch('/api/setup/join', { cache: 'no-store' });
    return (await res.json())?.data ?? null;
  } catch {
    return null;
  }
}

/**
 * Setup alternative to creating an admin: join this fresh node to an existing
 * cluster with a code from Settings > Cluster on a member. Accounts, servers
 * and settings then come from the cluster.
 */
export default function JoinClusterForm() {
  const router = useRouter();
  const [status, setStatus] = useState<JoinStatus | null>(null);
  const [code, setCode] = useState('');
  const [advHost, setAdvHost] = useState('');
  const [nodeId, setNodeId] = useState('');
  const [error, setError] = useState('');
  const [phase, setPhase] = useState<'form' | 'submitting' | 'joining' | 'joined' | 'timeout'>('form');

  useEffect(() => {
    getStatus().then(s => {
      setStatus(s);
      if (!s) return;
      const host = window.location.hostname;
      setAdvHost(s.adv_host && s.adv_host !== 'localhost' ? s.adv_host : host !== 'localhost' && !host.startsWith('127.') ? host : '');
      setNodeId(s.node_id || '');
    });
  }, []);

  // After submitting: wait for the database to come back as part of the cluster.
  useEffect(() => {
    if (phase !== 'joining') return;
    const started = Date.now();
    const t = setInterval(async () => {
      const s = await getStatus();
      if (s?.joined) {
        setPhase('joined');
        clearInterval(t);
        setTimeout(() => router.push('/login'), 1500);
      } else if (Date.now() - started > 120_000) {
        setPhase('timeout');
        clearInterval(t);
      }
    }, 2500);
    return () => clearInterval(t);
  }, [phase, router]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setPhase('submitting');
    try {
      const res = await fetch('/api/setup/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code.trim(), adv_host: advHost.trim(), node_id: nodeId.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error?.message || 'Joining failed');
        setPhase('form');
        return;
      }
      setPhase('joining');
    } catch {
      setError('An error occurred');
      setPhase('form');
    }
  };

  if (phase === 'joining' || phase === 'joined' || phase === 'timeout') {
    return (
      <Card>
        <CardHeader><CardTitle>Joining the cluster</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm">
          {phase === 'joining' && (
            <p className="flex items-center gap-2">
              <RefreshCw className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />
              Restarting the database and copying the cluster&apos;s data…
            </p>
          )}
          {phase === 'joined' && <p className="text-success">Joined. Sign in with an account from the cluster.</p>}
          {phase === 'timeout' && (
            <div role="alert" className="space-y-2 text-destructive">
              <p>This node has not joined yet.</p>
              <p className="text-muted-foreground">
                Check that this machine reaches the cluster on ports 4001 and 4002 and that the cluster reaches this machine at {advHost}. The container log (rqlite service) shows the details.
              </p>
              <Button variant="outline" size="sm" onClick={() => setPhase('joining')}>Keep waiting</Button>
            </div>
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader><CardTitle>Join an existing cluster</CardTitle></CardHeader>
      <CardContent>
        {status && !status.joinable ? (
          <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            {status.reason || 'This node cannot join a cluster.'}
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            {error && (
              <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                {error}
              </div>
            )}
            <p className="text-sm text-muted-foreground">
              On a cluster member, open Settings &gt; Cluster &gt; Add a node and create a join code. Users, servers and settings come from the cluster, so no admin account is created here.
            </p>
            <div className="space-y-2">
              <Label htmlFor="join-code">Join code</Label>
              <textarea
                id="join-code"
                value={code}
                onChange={e => setCode(e.target.value)}
                required
                spellCheck={false}
                autoComplete="off"
                placeholder="BOSUN-JOIN-1.…"
                className="h-24 w-full resize-none rounded-md border bg-transparent p-2 font-mono text-xs break-all focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="join-adv">Address of this machine</Label>
              <Input id="join-adv" value={advHost} onChange={e => setAdvHost(e.target.value)} placeholder="192.168.1.21" required />
              <p className="text-xs text-muted-foreground">LAN IP or DNS name the cluster can reach this machine at. Ports 4001 and 4002 must be published.</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="join-node">Node name</Label>
              <Input id="join-node" value={nodeId} onChange={e => setNodeId(e.target.value)} required />
            </div>
            <Button type="submit" size="lg" className="w-full" disabled={phase === 'submitting' || !status}>
              {phase === 'submitting' ? 'Joining…' : 'Join cluster'}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
