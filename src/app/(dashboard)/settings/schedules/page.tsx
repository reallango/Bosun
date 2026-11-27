'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CirclePlay, History, Pause, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import { PageHeader } from '@/components/settings/PageHeader';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { LoadingSpinner } from '@/components/shared/LoadingSpinner';
import { ErrorState } from '@/components/shared/ErrorState';
import { useToast } from '@/components/ui/toast';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import { readJson } from '@/lib/api/readJson';
import { cn } from '@/lib/utils';
import { cronFromPreset, nextRun, presetFromCron, validateTimeZone } from '@/lib/schedules/cron';

interface ScheduleRun {
  id: string;
  started_at: string;
  finished_at: string | null;
  status: 'running' | 'success' | 'failed' | 'skipped';
  message: string | null;
  job_id: string | null;
  matched_count: number | null;
}

interface Schedule {
  id: string;
  name: string;
  widget_type: string;
  schedule_kind: string;
  kind_label: string;
  server_id: string;
  server_name: string | null;
  resource: { kind: 'stack' | 'container'; name: string } | null;
  cron: string;
  timezone: string;
  enabled: boolean;
  options: { args?: Record<string, unknown>; params?: Record<string, unknown>; keepRuns?: number };
  created_by: { type: 'user' | 'api_key'; id: string; name: string };
  created_at: string;
  updated_at: string;
  last_run_at: string | null;
  next_run_at: string | null;
  paused_reason: string | null;
  last_run: ScheduleRun | null;
}

interface ScheduleKind {
  widget_type: string;
  widget_name: string;
  package_id: string;
  id: string;
  label: string;
  description?: string;
  target: 'server' | 'stack' | 'container' | 'byKind';
  run: 'dataset' | 'action';
}

interface Server { id: string; name: string; hostname?: string }

type Preset = 'hourly' | 'daily' | 'weekly' | 'custom';

const STATUS_STYLE: Record<string, string> = {
  success: 'bg-success/15 text-success',
  failed: 'bg-destructive/15 text-destructive',
  running: 'bg-primary/15 text-primary',
  skipped: 'bg-muted text-muted-foreground',
};

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function when(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function StatusBadge({ status }: { status: string }) {
  return <span className={cn('rounded px-1.5 py-0.5 text-[11px] font-medium uppercase', STATUS_STYLE[status] ?? 'bg-muted text-muted-foreground')}>{status}</span>;
}

function TimeFields({ preset, setPreset, time, setTime, weekday, setWeekday, cron, setCron }: {
  preset: Preset;
  setPreset: (v: Preset) => void;
  time: string; setTime: (v: string) => void;
  weekday: number; setWeekday: (v: number) => void;
  cron: string; setCron: (v: string) => void;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor="schedule-preset">When</Label>
      <select id="schedule-preset" className="form-select" value={preset} onChange={e => setPreset(e.target.value as Preset)}>
        <option value="hourly">Every hour</option>
        <option value="daily">Every day at a time</option>
        <option value="weekly">Every week on a day and time</option>
        <option value="custom">Custom cron expression</option>
      </select>
      {preset === 'daily' && <Input aria-label="Time of day" type="time" value={time} onChange={e => setTime(e.target.value)} />}
      {preset === 'weekly' && (
        <div className="flex gap-2">
          <select aria-label="Weekday" className="form-select flex-1" value={weekday} onChange={e => setWeekday(Number(e.target.value))}>
            {WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
          </select>
          <Input aria-label="Time of day" type="time" value={time} onChange={e => setTime(e.target.value)} className="w-36" />
        </div>
      )}
      {preset === 'custom' && (
        <>
          <Input aria-label="Cron expression" value={cron} onChange={e => setCron(e.target.value)} placeholder="0 3 * * *" className="font-mono" />
          <p className="text-xs text-muted-foreground">minute hour day-of-month month day-of-week, with *, lists, ranges and steps.</p>
        </>
      )}
    </div>
  );
}

function ScheduleDialog({ open, schedule, servers, onClose, onSaved }: {
  open: boolean;
  schedule: Schedule | null;
  servers: Server[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const initial = useMemo<{ preset: Preset; time: string; weekday: number; cron: string }>(() => {
    if (!schedule) return { preset: 'daily', time: '03:00', weekday: 0, cron: '0 3 * * *' };
    const p = presetFromCron(schedule.cron);
    const time = p && p.kind !== 'hourly' ? `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}` : '03:00';
    return { preset: p?.kind ?? 'custom', time, weekday: p?.kind === 'weekly' ? p.weekday : 0, cron: schedule.cron };
  }, [schedule]);

  const [name, setName] = useState(schedule?.name ?? '');
  const [serverId, setServerId] = useState(schedule?.server_id ?? servers[0]?.id ?? '');
  const [kindId, setKindId] = useState(schedule ? `${schedule.widget_type}:${schedule.schedule_kind}` : '');
  const [resourceName, setResourceName] = useState(schedule?.resource?.name ?? '');
  const [resourceKind, setResourceKind] = useState<'container' | 'stack'>(schedule?.resource?.kind ?? 'container');
  const [preset, setPreset] = useState<Preset>(initial.preset);
  const [time, setTime] = useState(initial.time);
  const [weekday, setWeekday] = useState(initial.weekday);
  const [cron, setCron] = useState(initial.cron);
  const [timezone, setTimezone] = useState(schedule?.timezone ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'));
  const [enabled, setEnabled] = useState(schedule?.enabled ?? true);
  const [kinds, setKinds] = useState<ScheduleKind[]>([]);
  const [loadingKinds, setLoadingKinds] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!serverId && servers.length) setServerId(servers[0].id);
  }, [servers, serverId]);

  useEffect(() => {
    if (!serverId) { setKinds([]); return; }
    let live = true;
    setLoadingKinds(true);
    fetchWithAuth(`/api/schedules/kinds?server_id=${encodeURIComponent(serverId)}`)
      .then(res => readJson<{ data?: { kinds?: ScheduleKind[] }; error?: { message?: string } }>(res))
      .then(json => {
        if (!live) return;
        setKinds(json.data?.kinds ?? []);
        if (json.error) setError(json.error.message ?? 'Could not load the schedule kinds');
      })
      .catch(err => { if (live) setError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { if (live) setLoadingKinds(false); });
    return () => { live = false; };
  }, [serverId]);

  const kind = kinds.find(k => `${k.widget_type}:${k.id}` === kindId) ?? null;
  const effectiveCron = preset === 'custom'
    ? cron
    : preset === 'hourly'
      ? cronFromPreset({ kind: 'hourly' }) ?? ''
      : preset === 'daily'
        ? cronFromPreset({ kind: 'daily', hour: Number(time.slice(0, 2)), minute: Number(time.slice(3, 5)) }) ?? ''
        : cronFromPreset({ kind: 'weekly', weekday, hour: Number(time.slice(0, 2)), minute: Number(time.slice(3, 5)) }) ?? '';
  const preview = useMemo(() => {
    if (!validateTimeZone(timezone)) return 'Unknown time zone';
    const next = nextRun(effectiveCron, timezone, new Date());
    return next ? `Next run: ${when(next.toISOString())} (${timezone})` : 'This timetable has no next run';
  }, [effectiveCron, timezone]);

  const save = async () => {
    setBusy(true); setError(null);
    try {
      if (!kind) throw new Error('Choose what should run');
      if (!name.trim()) throw new Error('Give the schedule a name');
      if (kind.target !== 'server' && !resourceName.trim()) throw new Error(`Name the ${kind.target === 'byKind' ? resourceKind : kind.target} this schedule is for`);
      const body = {
        name: name.trim(), widget_type: kind.widget_type, schedule_kind: kind.id, server_id: serverId,
        resource_kind: kind.target === 'server' ? '' : kind.target === 'byKind' ? resourceKind : kind.target,
        resource_name: kind.target === 'server' ? '' : resourceName.trim(),
        cron: effectiveCron, timezone: timezone.trim(), enabled,
      };
      const res = schedule
        ? await fetchWithAuth(`/api/schedules/${encodeURIComponent(schedule.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        : await fetchWithAuth('/api/schedules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const json = await readJson<{ error?: { message?: string } }>(res);
      if (!res.ok) throw new Error(json.error?.message || `HTTP ${res.status}`);
      toast(schedule ? 'Schedule saved' : 'Schedule created', { variant: 'success' });
      onSaved(); onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{schedule ? 'Edit schedule' : 'New schedule'}</DialogTitle>
          <DialogDescription>Runs as you, on the cluster leader, and re-checks your permission every time.</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="schedule-name">Name</Label>
              <Input id="schedule-name" value={name} onChange={e => setName(e.target.value)} maxLength={80} placeholder="Nightly update check" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="schedule-server">Server</Label>
              <select id="schedule-server" className="form-select" value={serverId} onChange={e => { setServerId(e.target.value); setKindId(''); }}>
                {servers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="schedule-kind">What to run</Label>
            <select id="schedule-kind" className="form-select" value={kindId} onChange={e => { setKindId(e.target.value); setResourceName(''); }} disabled={loadingKinds || !kinds.length}>
              <option value="">{loadingKinds ? 'Loading…' : kinds.length ? 'Choose a schedule kind' : 'No installed widget offers schedules on this server'}</option>
              {kinds.map(k => <option key={`${k.widget_type}:${k.id}`} value={`${k.widget_type}:${k.id}`}>{k.widget_name}: {k.label}</option>)}
            </select>
            {kind?.description && <p className="text-xs text-muted-foreground">{kind.description}</p>}
            {kind && <p className="text-xs text-muted-foreground">{kind.run === 'dataset' ? 'Reads a dataset and notifies when rows match.' : 'Runs an action as a job.'}</p>}
          </div>
          {kind && kind.target !== 'server' && (
            <div className="space-y-2">
              {kind.target === 'byKind' && (
                <div className="space-y-2">
                  <Label htmlFor="schedule-resource-kind">Kind</Label>
                  <select id="schedule-resource-kind" className="form-select" value={resourceKind} onChange={e => setResourceKind(e.target.value === 'stack' ? 'stack' : 'container')}>
                    <option value="container">Container</option>
                    <option value="stack">Stack</option>
                  </select>
                </div>
              )}
              <Label htmlFor="schedule-resource">{kind.target === 'stack' ? 'Stack' : kind.target === 'container' ? 'Container' : 'Name'}</Label>
              <Input id="schedule-resource" value={resourceName} onChange={e => setResourceName(e.target.value)} placeholder={kind.target === 'stack' ? 'my-stack' : kind.target === 'container' ? 'my-container' : resourceKind === 'stack' ? 'my-stack' : 'my-container'} />
            </div>
          )}
          <TimeFields preset={preset} setPreset={setPreset} time={time} setTime={setTime} weekday={weekday} setWeekday={setWeekday} cron={cron} setCron={setCron} />
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="schedule-timezone">Time zone</Label>
              <Input id="schedule-timezone" value={timezone} onChange={e => setTimezone(e.target.value)} placeholder="Europe/Berlin" className="font-mono" />
            </div>
            <label className="flex items-end gap-2 pb-2 text-sm">
              <input type="checkbox" className="size-4 accent-primary" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
              Enabled
            </label>
          </div>
          <p className={cn('text-xs', preview.startsWith('Next run') ? 'text-muted-foreground' : 'text-destructive')}>{preview}</p>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={save} disabled={busy || !kind}>{busy ? 'Saving…' : schedule ? 'Save' : 'Create schedule'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function HistoryDialog({ schedule, onClose }: { schedule: Schedule; onClose: () => void }) {
  const [runs, setRuns] = useState<ScheduleRun[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async (offset: number) => {
    setLoading(true); setError(null);
    try {
      const json = await readJson<{ data?: { runs?: ScheduleRun[]; nextOffset?: number | null }; error?: { message?: string } }>(
        await fetchWithAuth(`/api/schedules/${encodeURIComponent(schedule.id)}/runs?limit=25&offset=${offset}`),
      );
      if (json.error) throw new Error(json.error.message);
      setRuns(prev => offset === 0 ? json.data?.runs ?? [] : [...prev, ...(json.data?.runs ?? [])]);
      setNextOffset(json.data?.nextOffset ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [schedule.id]);
  useEffect(() => { load(0); }, [load]);
  return (
    <Dialog open onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Run history: {schedule.name}</DialogTitle>
          <DialogDescription>{schedule.kind_label} on {schedule.server_name ?? schedule.server_id}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          {error ? <ErrorState message={error} onRetry={() => load(0)} /> : loading && !runs.length ? <LoadingSpinner /> : (
            <Table>
              <TableHeader><TableRow><TableHead>Started</TableHead><TableHead>Result</TableHead><TableHead>Matched</TableHead><TableHead>Detail</TableHead></TableRow></TableHeader>
              <TableBody>
                {runs.map(r => (
                  <TableRow key={r.id}>
                    <TableCell className="whitespace-nowrap text-xs">{when(r.started_at)}</TableCell>
                    <TableCell><StatusBadge status={r.status} /></TableCell>
                    <TableCell className="text-xs">{r.matched_count ?? '—'}</TableCell>
                    <TableCell className="max-w-md text-xs text-muted-foreground">
                      {r.message ?? '—'}{r.job_id ? <span className="ml-1 font-mono text-[10px]">job {r.job_id.slice(0, 8)}</span> : null}
                    </TableCell>
                  </TableRow>
                ))}
                {!runs.length && <TableRow><TableCell colSpan={4} className="text-sm text-muted-foreground">No runs yet.</TableCell></TableRow>}
              </TableBody>
            </Table>
          )}
          {nextOffset !== null && <Button variant="outline" size="sm" className="mt-3" onClick={() => load(nextOffset)} disabled={loading}>Load more</Button>}
        </DialogBody>
        <DialogFooter><Button variant="outline" onClick={onClose}>Close</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function SchedulesPage() {
  const { toast } = useToast();
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [servers, setServers] = useState<Server[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Schedule | 'new' | null>(null);
  const [history, setHistory] = useState<Schedule | null>(null);
  const [deleting, setDeleting] = useState<Schedule | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const json = await readJson<{ data?: { schedules?: Schedule[] }; error?: { message?: string } }>(await fetchWithAuth('/api/schedules'));
      if (json.error) throw new Error(json.error.message);
      setSchedules(json.data?.schedules ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    fetchWithAuth('/api/servers')
      .then(res => readJson<{ data?: { servers?: Server[] } }>(res))
      .then(json => setServers(json.data?.servers ?? []))
      .catch(() => undefined);
  }, []);

  const toggle = async (s: Schedule) => {
    setBusy(s.id);
    try {
      const res = await fetchWithAuth(`/api/schedules/${encodeURIComponent(s.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !s.enabled }) });
      const json = await readJson<{ error?: { message?: string } }>(res);
      if (!res.ok) throw new Error(json.error?.message || `HTTP ${res.status}`);
      toast(s.enabled ? 'Schedule paused' : 'Schedule resumed', { variant: 'success' });
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), { variant: 'error' });
    } finally {
      setBusy(null);
    }
  };

  const runNow = async (s: Schedule) => {
    setBusy(s.id);
    try {
      const res = await fetchWithAuth(`/api/schedules/${encodeURIComponent(s.id)}/run`, { method: 'POST' });
      const json = await readJson<{ data?: { status?: string; message?: string; matchedCount?: number }; error?: { message?: string } }>(res);
      if (!res.ok) throw new Error(json.error?.message || `HTTP ${res.status}`);
      toast(json.data?.message || (json.data?.status === 'failed' ? 'The run failed' : 'Started'), { variant: json.data?.status === 'failed' ? 'error' : 'success' });
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), { variant: 'error' });
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!deleting) return;
    setBusy(deleting.id);
    try {
      const res = await fetchWithAuth(`/api/schedules/${encodeURIComponent(deleting.id)}`, { method: 'DELETE' });
      const json = await readJson<{ error?: { message?: string } }>(res);
      if (!res.ok) throw new Error(json.error?.message || `HTTP ${res.status}`);
      toast('Schedule deleted', { variant: 'success' });
      setDeleting(null);
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), { variant: 'error' });
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <PageHeader
        title="Schedules"
        description="Run what installed widgets offer, on a timetable, as you."
        actions={<Button onClick={() => setEditing('new')}><Plus />New schedule</Button>}
      />
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Only the cluster leader runs schedules, so they keep going when a node is down. Each run re-checks the creator&rsquo;s
          permission; if it is gone the schedule pauses and the bell tells you why. Dataset runs raise one notice when rows match.
        </p>
        {loading ? <LoadingSpinner /> : error ? <ErrorState message={error} onRetry={load} /> : schedules.length === 0 ? (
          <Card><CardContent className="py-10 text-center text-sm text-muted-foreground">
            No schedules yet. Installed widgets that declare one appear under &ldquo;New schedule&rdquo;.
          </CardContent></Card>
        ) : (
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Kind</TableHead>
                    <TableHead>Server / target</TableHead>
                    <TableHead>Next run</TableHead>
                    <TableHead>Last result</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {schedules.map(s => (
                    <TableRow key={s.id}>
                      <TableCell>
                        <div className="font-medium">{s.name}</div>
                        <div className="text-xs text-muted-foreground">
                          {s.enabled ? 'Enabled' : s.paused_reason ?? 'Paused'}
                        </div>
                      </TableCell>
                      <TableCell className="text-sm">{s.kind_label}<div className="text-xs text-muted-foreground">{s.widget_type}</div></TableCell>
                      <TableCell className="text-sm">{s.server_name ?? s.server_id}{s.resource ? <div className="text-xs text-muted-foreground">{s.resource.kind}: {s.resource.name}</div> : null}</TableCell>
                      <TableCell className="whitespace-nowrap text-xs">{s.enabled ? when(s.next_run_at) : '—'}</TableCell>
                      <TableCell className="text-xs">
                        {s.last_run ? <div className="space-y-1"><StatusBadge status={s.last_run.status} /><div className="text-muted-foreground">{when(s.last_run.started_at)}{s.last_run.matched_count !== null ? ` · ${s.last_run.matched_count} matched` : ''}</div></div> : <span className="text-muted-foreground">Never run</span>}
                      </TableCell>
                      <TableCell>
                        <div className="flex justify-end gap-1">
                          <Button variant="ghost" size="icon-sm" title="Run now" aria-label={`Run ${s.name} now`} onClick={() => runNow(s)} disabled={busy === s.id}><Play /></Button>
                          <Button variant="ghost" size="icon-sm" title={s.enabled ? 'Pause' : 'Resume'} aria-label={`${s.enabled ? 'Pause' : 'Resume'} ${s.name}`} onClick={() => toggle(s)} disabled={busy === s.id}>{s.enabled ? <Pause /> : <CirclePlay />}</Button>
                          <Button variant="ghost" size="icon-sm" title="History" aria-label={`History of ${s.name}`} onClick={() => setHistory(s)}><History /></Button>
                          <Button variant="ghost" size="icon-sm" title="Edit" aria-label={`Edit ${s.name}`} onClick={() => setEditing(s)}><Pencil /></Button>
                          <Button variant="ghost" size="icon-sm" title="Delete" aria-label={`Delete ${s.name}`} onClick={() => setDeleting(s)} disabled={busy === s.id}><Trash2 /></Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
      </div>
      {editing && (
        <ScheduleDialog
          key={editing === 'new' ? 'new' : editing.id}
          open
          schedule={editing === 'new' ? null : editing}
          servers={servers}
          onClose={() => setEditing(null)}
          onSaved={load}
        />
      )}
      {history && <HistoryDialog schedule={history} onClose={() => setHistory(null)} />}
      <Dialog open={!!deleting} onOpenChange={o => { if (!o) setDeleting(null); }}>
        <DialogContent size="sm">
          <DialogHeader><DialogTitle>Delete this schedule?</DialogTitle><DialogDescription>Its run history is deleted too. This cannot be undone.</DialogDescription></DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)}>Cancel</Button>
            <Button variant="destructive" onClick={remove} disabled={!deleting || busy === deleting.id}><Trash2 />Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
