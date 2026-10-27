'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { TriangleAlert } from 'lucide-react';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import { readJson } from '@/lib/api/readJson';

interface Summary {
  state: 'ok' | 'reduced' | 'no_quorum' | 'single';
  voters: number;
  reachable_voters: number;
  quorum_size: number;
}

/**
 * App-wide warning when the database cluster is degraded: amber when a node
 * is down but a leader exists, red when there is no leader (read-only, data
 * frozen, no polling).
 */
export function ClusterBanner() {
  const [s, setS] = useState<Summary | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => fetchWithAuth('/api/cluster/status')
      .then(r => readJson<{ data?: Summary }>(r))
      .then(j => { if (alive) setS(j.data || null); })
      .catch(() => undefined);
    load();
    const t = setInterval(() => { if (!document.hidden) load(); }, 20_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  if (!s || s.state === 'ok' || s.state === 'single') return null;
  const down = s.voters - s.reachable_voters;
  const red = s.state === 'no_quorum';
  return (
    <div role="status" className={`flex items-start gap-2 border-b px-4 py-2 text-sm ${red ? 'bg-destructive/10 text-destructive' : 'bg-yellow-500/10 text-yellow-800 dark:text-yellow-300'}`}>
      <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      <p className="min-w-0">
        {red
          ? <>Database cluster has no leader ({s.reachable_voters} of {s.voters} nodes reachable, {s.quorum_size} needed). Bosun is read-only: data shown is from when quorum was lost and nothing is being polled. </>
          : <>{down} of {s.voters} database nodes {down === 1 ? 'is' : 'are'} offline. Everything works, but one more failure would make Bosun read-only. </>}
        <Link href="/settings/cluster" className="font-medium underline">Cluster status</Link>
      </p>
    </div>
  );
}
