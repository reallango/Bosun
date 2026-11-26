'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Check, KeyRound, X } from 'lucide-react';
import Header from '@/components/layout/Header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LoadingSpinner } from '@/components/shared/LoadingSpinner';
import { ErrorState } from '@/components/shared/ErrorState';
import { useToast } from '@/components/ui/toast';
import { useAuth } from '@/hooks/useAuth';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import { readJson } from '@/lib/api/readJson';
import { hasRole } from '@/lib/auth/levels';
import { formatDistanceToNow } from '@/lib/utils/date';
import { cn } from '@/lib/utils';

interface AccessRequest {
  id: string;
  kind: 'grant' | 'one_time';
  status: string;
  requester: { type: 'user' | 'api_key'; id: string; name: string };
  permission: string;
  permission_label: string;
  risk: string;
  server_name: string | null;
  resource: { kind: string; name: string } | null;
  duration_hours: number | null;
  action: { widget_type: string; action_id: string; label: string; params: Record<string, unknown> } | null;
  reason: string | null;
  summary: string;
  created_at: string;
  expires_at: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  result: unknown;
}

const STATUS_STYLE: Record<string, string> = {
  pending: 'bg-warning/15 text-warning',
  approved: 'bg-success/15 text-success',
  denied: 'bg-destructive/15 text-destructive',
  failed: 'bg-destructive/15 text-destructive',
  expired: 'bg-muted text-muted-foreground',
  cancelled: 'bg-muted text-muted-foreground',
};

function RequestCard({ r, highlight, canDecide, onDecided }: { r: AccessRequest; highlight: boolean; canDecide: boolean; onDecided: () => void }) {
  const { toast } = useToast();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const decide = async (decision: 'approve' | 'deny') => {
    setBusy(true); setError(null);
    try {
      const res = await fetchWithAuth(`/api/access-requests/${encodeURIComponent(r.id)}/decision`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision, note: note.trim() || undefined }),
      });
      const json = await readJson<{ data?: { request: AccessRequest }; error?: { message?: string } }>(res);
      if (!res.ok || !json.data) { setError(json.error?.message || `HTTP ${res.status}`); return; }
      const s = json.data.request.status;
      toast(s === 'failed' ? 'Approved, but it could not be carried out (see the result)' : decision === 'approve' ? 'Approved' : 'Denied', { variant: s === 'failed' ? 'error' : 'success' });
      onDecided();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const who = `${r.requester.name}${r.requester.type === 'api_key' ? ' (API key)' : ''}`;
  return (
    <div id={`req-${r.id}`} className={cn('space-y-2 rounded-lg border p-3', highlight && 'ring-2 ring-primary')}>
      <div className="flex flex-wrap items-center gap-2">
        <KeyRound className="size-4 text-muted-foreground" aria-hidden />
        <span className="font-medium">{who}</span>
        <span className="text-sm text-muted-foreground">asks to {r.kind === 'one_time' ? r.summary : `get ${r.summary}`}</span>
        <span className={cn('ml-auto rounded px-1.5 py-0.5 text-[11px] font-medium uppercase', STATUS_STYLE[r.status] ?? 'bg-muted')}>{r.status}</span>
      </div>
      <div className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
        <div>Permission: <span className="text-foreground">{r.permission_label}</span> <span className="font-mono">({r.permission})</span>, {r.risk} risk</div>
        <div>Asked {formatDistanceToNow(new Date(r.created_at))}{r.status === 'pending' ? `, expires ${formatDistanceToNow(new Date(r.expires_at))}` : ''}</div>
        {r.reason && <div className="sm:col-span-2">Reason: <span className="text-foreground">{r.reason}</span></div>}
        {r.decided_by && <div className="sm:col-span-2">{r.status === 'denied' ? 'Denied' : 'Decided'} by {r.decided_by}{r.decided_at ? ` ${formatDistanceToNow(new Date(r.decided_at))}` : ''}{r.decision_note ? `: ${r.decision_note}` : ''}</div>}
      </div>
      {r.action && (
        <details className="text-xs">
          <summary className="cursor-pointer text-primary">What will run: {r.action.label} ({r.action.widget_type}/{r.action.action_id})</summary>
          <pre className="mt-1 max-h-48 overflow-auto rounded bg-muted p-2 font-mono text-[11px]">{JSON.stringify(r.action.params, null, 2)}</pre>
          <p className="mt-1 text-muted-foreground">Long text (a compose file, settings) shows only its size here; the full request runs exactly as it was sent.</p>
        </details>
      )}
      {r.result != null && (
        <details className="text-xs">
          <summary className="cursor-pointer text-primary">Result</summary>
          <pre className="mt-1 max-h-48 overflow-auto rounded bg-muted p-2 font-mono text-[11px]">{JSON.stringify(r.result, null, 2)}</pre>
        </details>
      )}
      {r.status === 'pending' && canDecide && (
        <div className="flex flex-wrap items-center gap-2">
          <Input aria-label="Note (optional)" placeholder="Note (optional)" value={note} onChange={e => setNote(e.target.value)} maxLength={500} className="h-8 max-w-sm text-xs" />
          <Button size="sm" onClick={() => decide('approve')} disabled={busy}><Check />{r.kind === 'one_time' ? 'Approve and run' : 'Approve'}</Button>
          <Button size="sm" variant="outline" onClick={() => decide('deny')} disabled={busy}><X />Deny</Button>
        </div>
      )}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

export default function AccessRequestsPage() {
  const { user } = useAuth();
  const canDecide = hasRole(user?.role, 'operator');
  const highlight = useSearchParams().get('id');
  const [requests, setRequests] = useState<AccessRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const json = await readJson<{ data?: { requests?: AccessRequest[] }; error?: { message?: string } }>(await fetchWithAuth('/api/access-requests?limit=200'));
      if (json.error) setError(json.error.message || 'Failed to load access requests');
      else setRequests(json.data?.requests ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load access requests');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!loading && highlight) document.getElementById(`req-${highlight}`)?.scrollIntoView({ block: 'center' });
  }, [loading, highlight]);

  const pending = requests.filter(r => r.status === 'pending');
  const done = requests.filter(r => r.status !== 'pending');

  return (
    <>
      <Header title="Access requests" />
      <div className="page max-w-5xl space-y-4">
        <p className="text-sm text-muted-foreground">
          API keys and users can ask for a permission (for a while or permanently, possibly for one stack or container) or for one
          action to be run once. You can approve what you hold yourself; high-risk permissions need Full access. Approved grants go
          into a group named &ldquo;Approved requests: &lt;name&gt;&rdquo; under Permissions, where you can change or remove them.
        </p>
        {loading ? <LoadingSpinner /> : error ? <ErrorState message={error} onRetry={load} /> : (
          <>
            <Card>
              <CardHeader><CardTitle>Waiting for a decision ({pending.length})</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {pending.length === 0 && <p className="text-sm text-muted-foreground">Nothing is waiting.</p>}
                {pending.map(r => <RequestCard key={r.id} r={r} highlight={r.id === highlight} canDecide={canDecide} onDecided={load} />)}
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle>Decided and expired</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {done.length === 0 && <p className="text-sm text-muted-foreground">None yet.</p>}
                {done.map(r => <RequestCard key={r.id} r={r} highlight={r.id === highlight} canDecide={false} onDecided={load} />)}
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </>
  );
}
