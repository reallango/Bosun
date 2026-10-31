'use client';

import { useCallback, useEffect, useState } from 'react';
import { Ban, Check, Copy, KeySquare, Plus, ShieldCheck, Trash2, TriangleAlert } from 'lucide-react';
import Header from '@/components/layout/Header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { LoadingSpinner } from '@/components/shared/LoadingSpinner';
import { ErrorState } from '@/components/shared/ErrorState';
import { useToast } from '@/components/ui/toast';
import { ConfirmActionDialog, apiAction } from '@/components/widgets/shared/ConfirmActionDialog';
import { AdminOnlyNotice, LevelBadge, LevelSelect, When } from '@/components/settings/access-ui';
import { GroupPicker } from '@/components/settings/permissions/GroupPicker';
import { KeyGroupsDialog } from '@/components/settings/permissions/KeyGroupsDialog';
import type { PermissionGroup } from '@/components/settings/permissions/data';
import { useAuth } from '@/hooks/useAuth';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import { readJson } from '@/lib/api/readJson';
import { ACCESS_LEVELS, hasRole, type Role } from '@/lib/auth/levels';
import { cn } from '@/lib/utils';

interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  role: string;
  created_by_username: string | null;
  created_at: string | null;
  last_used_at: string | null;
  last_used_ip: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  status: 'active' | 'revoked' | 'expired';
  group_ids?: string[];
}

const EXPIRY_OPTIONS: [string, string][] = [['never', 'Never'], ['30', '30 days'], ['90', '90 days'], ['365', '1 year']];

/** The most useful endpoints for automation, with the minimum level. */
const ENDPOINTS: { method: string; path: string; what: string; role: Role }[] = [
  { method: 'GET', path: '/api/servers', what: 'List servers with online status and hardware', role: 'viewer' },
  { method: 'GET', path: '/api/servers/:id', what: 'One server', role: 'viewer' },
  { method: 'GET', path: '/api/dashboards/:id', what: 'A dashboard and its widgets (widget ids)', role: 'viewer' },
  { method: 'GET', path: '/api/widgets/:widgetId/data', what: 'Live data of a widget (CPU, disks, containers, …)', role: 'viewer' },
  { method: 'GET', path: '/api/metrics?serverId=…&metrics=cpu.usage,mem.used_pct&range=24h', what: 'Metric history', role: 'viewer' },
  { method: 'GET', path: '/api/cluster/status', what: 'Database cluster status', role: 'viewer' },
  { method: 'POST', path: '/api/servers/:id/wake', what: 'Wake-on-LAN', role: 'operator' },
  { method: 'GET', path: '/api/widgets/:widgetId/data?force=true', what: 'Force a fresh poll of the host', role: 'operator' },
  { method: 'POST', path: '/api/servers/:id/exec', what: 'Run a command on the host: {"command":"uptime"}', role: 'admin' },
  { method: 'POST', path: '/api/servers/:id/shell/exec', what: 'Run a command as the non-admin shell account (needs the Shell permission): {"command":"uptime"}', role: 'admin' },
  { method: 'POST', path: '/api/servers/:id/terminal', what: 'Get a 60 s single-use token for wss://<host>/ws/api-terminal?token=…: {"target":"host"} (Shell permission) or {"target":"container","container":"name"} (Docker shell permission only)', role: 'admin' },
];

function StatusText({ status }: { status: ApiKey['status'] }) {
  return (
    <span className={cn('rounded px-2 py-0.5 text-xs',
      status === 'active' ? 'bg-green-500/15 text-green-700 dark:text-green-400' : 'bg-muted text-muted-foreground')}>
      {status === 'active' ? 'Active' : status === 'revoked' ? 'Revoked' : 'Expired'}
    </span>
  );
}

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };
  return (
    <Button type="button" variant="outline" onClick={copy}>
      {copied ? <Check /> : <Copy />}
      {copied ? 'Copied' : label}
    </Button>
  );
}

function CreateKeyDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [role, setRole] = useState<string>('viewer');
  const [expiry, setExpiry] = useState('90');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [groups, setGroups] = useState<PermissionGroup[]>([]);

  useEffect(() => {
    if (open) {
      setName(''); setRole('viewer'); setExpiry('90'); setError(null); setCreatedKey(null); setGroupIds([]);
      fetchWithAuth('/api/permission-groups').then(r => r.json()).then(j => setGroups(j.data?.groups ?? [])).catch(() => setGroups([]));
    }
  }, [open]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const data = await apiAction(fetchWithAuth, '/api/api-keys', 'POST', {
        name, role, expires_in_days: expiry === 'never' ? null : Number(expiry),
      }) as { key?: string; apiKey?: { id?: string } };
      if (groupIds.length && data?.apiKey?.id) {
        await apiAction(fetchWithAuth, `/api/api-keys/${data.apiKey.id}/groups`, 'PUT', { group_ids: groupIds });
      }
      setCreatedKey(data?.key ?? null);
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={o => { if (!saving) onOpenChange(o); }}>
      <DialogContent size="lg" onInteractOutside={e => { if (createdKey) e.preventDefault(); }}>
        <DialogHeader>
          <DialogTitle>{createdKey ? 'API key created' : 'New API key'}</DialogTitle>
          <DialogDescription>
            {createdKey ? 'Copy the key now and store it somewhere safe.' : 'For scripts, automation and AI agents. Keys work for the API only, not for signing in.'}
          </DialogDescription>
        </DialogHeader>
        {createdKey ? (
          <>
            <DialogBody className="space-y-3">
              <div role="alert" className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
                <span>This is the only time the full key is shown. Bosun stores just a hash of it; if you lose it, revoke it and create a new one.</span>
              </div>
              <Label htmlFor="new-key">API key</Label>
              <Input id="new-key" readOnly value={createdKey} className="font-mono text-xs" onFocus={e => e.currentTarget.select()} />
            </DialogBody>
            <DialogFooter>
              <CopyButton text={createdKey} label="Copy key" />
              <Button onClick={() => onOpenChange(false)}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={submit} className="contents">
            <DialogBody className="space-y-4">
              {error && <div role="alert" className="rounded-md bg-destructive/10 p-2 text-sm text-destructive">{error}</div>}
              <div className="space-y-1.5">
                <Label htmlFor="key-name">Name</Label>
                <Input id="key-name" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. home-assistant, ai-agent" maxLength={100} required />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="key-role">Access level</Label>
                <LevelSelect id="key-role" value={role} onChange={setRole} />
              </div>
              <div className="space-y-1.5">
                <Label>Permission groups</Label>
                <GroupPicker groups={groups} selected={groupIds} onChange={setGroupIds} />
                <p className="text-xs text-muted-foreground">
                  Add individual actions to a low access level, for example a Read only key that can also restart one server.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="key-expiry">Expires</Label>
                <select id="key-expiry" className="form-select" value={expiry} onChange={e => setExpiry(e.target.value)}>
                  {EXPIRY_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
              <Button type="submit" disabled={saving || !name.trim()}>{saving ? 'Creating…' : 'Create key'}</Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function KeyActions({ k, onPending, onGroups }: { k: ApiKey; onPending: (p: { kind: 'revoke' | 'delete'; key: ApiKey }) => void; onGroups: (k: ApiKey) => void }) {
  return (
    <div className="flex shrink-0 items-center justify-end gap-0.5">
      <Button variant="ghost" size="icon-lg" onClick={() => onGroups(k)} aria-label={`Permission groups for ${k.name}`} title="Permission groups">
        <ShieldCheck />
      </Button>
      {k.status === 'active' && (
        <Button variant="ghost" size="icon-lg" onClick={() => onPending({ kind: 'revoke', key: k })} aria-label={`Revoke ${k.name}`} title="Revoke">
          <Ban />
        </Button>
      )}
      <Button variant="ghost" size="icon-lg" onClick={() => onPending({ kind: 'delete', key: k })} aria-label={`Delete ${k.name}`} title="Delete">
        <Trash2 className="text-destructive" />
      </Button>
    </div>
  );
}

export default function ApiAccessPage() {
  const { user } = useAuth();
  const isAdmin = hasRole(user?.role, 'admin');
  const { toast } = useToast();
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [pending, setPending] = useState<{ kind: 'revoke' | 'delete'; key: ApiKey } | null>(null);
  const [groupsFor, setGroupsFor] = useState<ApiKey | null>(null);
  const [origin, setOrigin] = useState('http://<host>:3042');

  useEffect(() => { if (typeof window !== 'undefined') setOrigin(window.location.origin); }, []);

  const load = useCallback(async () => {
    setError(null);
    try {
      const json = await readJson<{ data?: { keys?: ApiKey[] }; error?: { message?: string } }>(await fetchWithAuth('/api/api-keys'));
      if (json.error) setError(json.error.message || 'Failed to load API keys');
      else setKeys(json.data?.keys ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load API keys');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isAdmin) load();
    else if (user) setLoading(false);
  }, [isAdmin, user, load]);

  const runPending = async () => {
    if (!pending) return;
    if (pending.kind === 'revoke') {
      await apiAction(fetchWithAuth, `/api/api-keys/${pending.key.id}`, 'PATCH', { revoked: true });
      toast(`Revoked ${pending.key.name}`, { variant: 'success' });
    } else {
      await apiAction(fetchWithAuth, `/api/api-keys/${pending.key.id}`, 'DELETE');
      toast(`Deleted ${pending.key.name}`, { variant: 'success' });
    }
    load();
  };

  const curl = `curl -H "Authorization: Bearer bosun_..." ${origin}/api/servers`;

  return (
    <>
      <Header title="API Access" />
      <div className="page max-w-6xl space-y-4">
        {!loading && !isAdmin ? (
          <AdminOnlyNotice />
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-muted-foreground">API keys let scripts and AI agents use the Bosun API without a browser session.</p>
              <Button size="lg" onClick={() => setCreateOpen(true)}><Plus />Create API key</Button>
            </div>

            <Card className="py-0">
              <CardContent className="px-0">
                {loading ? (
                  <LoadingSpinner />
                ) : error ? (
                  <ErrorState message={error} onRetry={load} />
                ) : keys.length === 0 ? (
                  <div className="py-8 text-center text-sm text-muted-foreground">No API keys yet</div>
                ) : (
                  <>
                    <ul className="divide-y md:hidden">
                      {keys.map(k => (
                        <li key={k.id} className="space-y-2 px-4 py-3 text-sm">
                          <div className="flex items-start justify-between gap-2">
                            <div className="flex min-w-0 items-center gap-2">
                              <KeySquare className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                              <div className="min-w-0">
                                <div className="truncate font-medium">{k.name}</div>
                                <code className="text-xs text-muted-foreground">bosun_{k.prefix}_…</code>
                              </div>
                            </div>
                            <StatusText status={k.status} />
                          </div>
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                            <LevelBadge role={k.role} />
                            {!!k.group_ids?.length && <span>+ {k.group_ids.length} group{k.group_ids.length === 1 ? '' : 's'}</span>}
                            <span>Created <When value={k.created_at} /></span>
                            <span>Used <When value={k.last_used_at} empty="never" /></span>
                            <span>Expires <When value={k.expires_at} empty="never" /></span>
                          </div>
                          <KeyActions k={k} onPending={setPending} onGroups={setGroupsFor} />
                        </li>
                      ))}
                    </ul>
                    <div className="hidden md:block">
                      <Table>
                        <TableHeader className="bg-muted/50">
                          <TableRow>
                            <TableHead className="px-4">Name</TableHead>
                            <TableHead>Access level</TableHead>
                            <TableHead>Key</TableHead>
                            <TableHead>Created</TableHead>
                            <TableHead>Last used</TableHead>
                            <TableHead>Expires</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead className="px-4 text-right">Actions</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {keys.map(k => (
                            <TableRow key={k.id}>
                              <TableCell className="max-w-[14rem] truncate px-4 font-medium">{k.name}</TableCell>
                              <TableCell>
                                <LevelBadge role={k.role} />
                                {!!k.group_ids?.length && <span className="ml-1.5 text-xs text-muted-foreground">+ {k.group_ids.length} group{k.group_ids.length === 1 ? '' : 's'}</span>}
                              </TableCell>
                              <TableCell><code className="text-xs">bosun_{k.prefix}_…</code></TableCell>
                              <TableCell className="text-muted-foreground">
                                <When value={k.created_at} />{k.created_by_username && <span className="block text-xs">by {k.created_by_username}</span>}
                              </TableCell>
                              <TableCell className="text-muted-foreground">
                                <When value={k.last_used_at} empty="never" />{k.last_used_ip && <span className="block text-xs">{k.last_used_ip}</span>}
                              </TableCell>
                              <TableCell className="text-muted-foreground"><When value={k.expires_at} empty="never" /></TableCell>
                              <TableCell><StatusText status={k.status} /></TableCell>
                              <TableCell className="px-4"><KeyActions k={k} onPending={setPending} onGroups={setGroupsFor} /></TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Using the API</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4 text-sm">
                <p className="text-muted-foreground">
                  API keys are meant for automation and AI agents. Send the key as a Bearer token; responses are JSON
                  (<code>{'{ "data": … }'}</code> or <code>{'{ "error": { "message", "code" } }'}</code>). Each key is limited to
                  300 requests per minute. Keys cannot sign in to the web UI, open terminals, or manage users and API keys.
                </p>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <pre className="min-w-0 flex-1 overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs">{curl}</pre>
                  <CopyButton text={curl} />
                </div>
                <ul className="space-y-1 text-muted-foreground">
                  {(['viewer', 'operator', 'admin'] as Role[]).map(r => (
                    <li key={r}><LevelBadge role={r} /> <span className="ml-1">{ACCESS_LEVELS[r].description}</span></li>
                  ))}
                </ul>
                <p className="text-muted-foreground">
                  Read + actions keys can run widget actions (containers, models, updates, wake) but cannot open shells or run arbitrary commands.
                </p>
                <div className="overflow-x-auto rounded-md border">
                  <Table>
                    <TableHeader className="bg-muted/50">
                      <TableRow>
                        <TableHead className="px-3">Endpoint</TableHead>
                        <TableHead>What</TableHead>
                        <TableHead className="px-3">Minimum level</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {ENDPOINTS.map(e => (
                        <TableRow key={e.method + e.path}>
                          <TableCell className="px-3 font-mono text-xs"><span className="text-muted-foreground">{e.method}</span> {e.path}</TableCell>
                          <TableCell className="whitespace-normal text-xs">{e.what}</TableCell>
                          <TableCell className="px-3"><LevelBadge role={e.role} /></TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          </>
        )}
      </div>

      <CreateKeyDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={load} />
      <KeyGroupsDialog keyId={groupsFor?.id ?? null} keyName={groupsFor?.name ?? ""} selected={groupsFor?.group_ids ?? []} onOpenChange={o => { if (!o) setGroupsFor(null); }} onSaved={load} />
      <ConfirmActionDialog
        open={!!pending}
        onOpenChange={o => { if (!o) setPending(null); }}
        title={pending ? `${pending.kind === 'revoke' ? 'Revoke' : 'Delete'} ${pending.key.name}?` : ''}
        description={pending?.kind === 'revoke'
          ? 'Requests using this key are refused from now on. Revocation cannot be undone; the key stays listed.'
          : 'The key is removed permanently and stops working.'}
        confirmLabel={pending?.kind === 'revoke' ? 'Revoke key' : 'Delete key'}
        destructive
        onConfirm={runPending}
      />
    </>
  );
}
