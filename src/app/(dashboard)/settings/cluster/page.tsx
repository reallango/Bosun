'use client';

import { useCallback, useEffect, useState } from 'react';
import { Crown, RefreshCw } from 'lucide-react';
import Header from '@/components/layout/Header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { LoadingSpinner } from '@/components/shared/LoadingSpinner';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import { readJson } from '@/lib/api/readJson';
import { cn } from '@/lib/utils';

interface ClusterNode { id: string; api_addr: string | null; addr: string; voter: boolean; reachable: boolean; leader: boolean; error?: string }
interface Summary {
  node_id: string | null;
  is_leader: boolean;
  leader_id: string | null;
  has_quorum: boolean;
  voters: number;
  reachable_voters: number;
  quorum_size: number;
  nodes: ClusterNode[];
  poller: { node: string; at: string; stale: boolean } | null;
  state: 'ok' | 'reduced' | 'no_quorum' | 'single';
}

const STATE: Record<Summary['state'], { label: string; cls: string; help: string }> = {
  ok: { label: 'Healthy', cls: 'bg-green-500/15 text-green-700 dark:text-green-400', help: 'All nodes are reachable.' },
  single: { label: 'Single node', cls: 'bg-muted text-muted-foreground', help: 'One-node deployment; there is no failover.' },
  reduced: { label: 'Degraded', cls: 'bg-yellow-500/15 text-yellow-800 dark:text-yellow-300', help: 'A leader exists, but some nodes are down. Another failure would leave the cluster without a majority.' },
  no_quorum: { label: 'No leader', cls: 'bg-destructive/15 text-destructive', help: 'Fewer than a majority of nodes are reachable. Bosun is read-only and shows the last replicated data; polling is paused until a majority is back.' },
};

export default function ClusterPage() {
  const [s, setS] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const j = await readJson<{ data?: Summary }>(await fetchWithAuth('/api/cluster/status'));
      setS(j.data || null);
    } catch (err) {
      console.error('Failed to load cluster status:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(() => { if (!document.hidden) load(); }, 10_000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <>
      <Header title="Cluster" />
      <div className="page max-w-5xl space-y-4">
        {loading || !s ? <LoadingSpinner /> : (
          <>
            <Card>
              <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
                <CardTitle className="flex items-center gap-2">
                  Database cluster
                  <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', STATE[s.state].cls)}>{STATE[s.state].label}</span>
                </CardTitle>
                <Button variant="outline" size="sm" onClick={load}><RefreshCw /> Refresh</Button>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <p className="text-muted-foreground">{STATE[s.state].help}</p>
                <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <div><dt className="text-muted-foreground">This node</dt><dd className="font-mono">{s.node_id || '-'}{s.is_leader && ' (leader)'}</dd></div>
                  <div><dt className="text-muted-foreground">Leader</dt><dd className="font-mono">{s.leader_id || 'none'}</dd></div>
                  <div><dt className="text-muted-foreground">Voters reachable</dt><dd>{s.reachable_voters} / {s.voters} (need {s.quorum_size})</dd></div>
                  <div>
                    <dt className="text-muted-foreground">Poller</dt>
                    <dd>{s.poller ? <><span className="font-mono">{s.poller.node}</span>{s.poller.stale ? <span className="text-destructive"> · stopped {new Date(s.poller.at).toLocaleTimeString()}</span> : ' · running'}</> : '-'}</dd>
                  </div>
                </dl>
                <p className="text-xs text-muted-foreground">
                  The poller runs only on the leader. Other nodes serve the same data from the shared database; their writes are forwarded to the leader.
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle>Nodes</CardTitle></CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Node</TableHead>
                      <TableHead>API</TableHead>
                      <TableHead>Raft</TableHead>
                      <TableHead>Role</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {s.nodes.map(n => (
                      <TableRow key={n.id}>
                        <TableCell className="font-mono text-xs">{n.id}{n.id === s.node_id && <span className="ml-1 text-muted-foreground">(this)</span>}</TableCell>
                        <TableCell className="font-mono text-xs">{n.api_addr || '-'}</TableCell>
                        <TableCell className="font-mono text-xs">{n.addr}</TableCell>
                        <TableCell>
                          {n.leader ? <span className="inline-flex items-center gap-1 text-primary"><Crown className="size-3.5" aria-hidden /> Leader</span>
                            : n.voter ? 'Follower' : 'Non-voter'}
                        </TableCell>
                        <TableCell>
                          <span className={n.reachable ? 'text-success' : 'text-destructive'} title={n.error}>{n.reachable ? 'Online' : 'Unreachable'}</span>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </>
  );
}
