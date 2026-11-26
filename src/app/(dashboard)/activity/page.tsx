'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { CircleAlert, CircleCheck, Loader2, RotateCcw, SquareArrowOutUpRight, TriangleAlert } from 'lucide-react';
import Header from '@/components/layout/Header';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { LogDialog } from '@/components/layout/TasksSection';
import { notificationIcon } from '@/components/layout/notificationIcon';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import { readJson } from '@/lib/api/readJson';
import { ensureArray } from '@/lib/api/ensureArray';
import { useAuth } from '@/hooks/useAuth';
import { useTasks, type Task } from '@/hooks/useTasks';
import { useNotifications } from '@/providers/NotificationProvider';
import { hasRole } from '@/lib/auth/levels';
import { formatDistanceToNow } from '@/lib/utils/date';
import { cn } from '@/lib/utils';
import { NOTIFICATION_KIND_GROUPS } from '@/lib/notifications/filters';
import { notificationTime, taskTime } from '@/lib/notifications/bell';

type TypeFilter = 'all' | 'alerts' | 'update' | 'access' | 'tasks';

interface HistoryNotification {
  id: string;
  kind: string;
  type: 'info' | 'warning' | 'error' | 'success';
  title: string;
  message: string;
  link: string | null;
  read: boolean;
  dismissed: boolean;
  server_id: string | null;
  created_at: string;
}

type ActivityItem =
  | { type: 'notification'; at: number; notification: HistoryNotification }
  | { type: 'task'; at: number; task: Task };

const TYPE_OPTIONS: { value: TypeFilter; label: string }[] = [
  { value: 'all', label: 'All activity' },
  { value: 'alerts', label: 'Alerts' },
  { value: 'update', label: 'Updates' },
  { value: 'access', label: 'Access' },
  { value: 'tasks', label: 'Tasks' },
];

const UPDATE_KINDS = new Set(NOTIFICATION_KIND_GROUPS.update);
const ACCESS = new Set(NOTIFICATION_KIND_GROUPS.access);

function DismissedBadge() {
  return <span className="rounded-full border bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Dismissed</span>;
}

function NotificationRow({
  n,
  serverName,
  canRestore,
  onRestore,
}: {
  n: HistoryNotification;
  serverName: string | null;
  canRestore: boolean;
  onRestore: () => void;
}) {
  const t = notificationIcon(n.kind, n.type);
  const at = notificationTime(n.created_at);
  return (
    <li className={cn('flex items-start gap-3 border-b px-4 py-3 last:border-b-0', n.dismissed && 'bg-muted/40')}>
      <t.icon className={cn('mt-0.5 size-4 shrink-0', t.className)} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          {n.link ? (
            <Link href={n.link} className="min-w-0 truncate text-sm font-medium text-foreground hover:underline">{n.title}</Link>
          ) : (
            <span className="min-w-0 truncate text-sm font-medium">{n.title}</span>
          )}
          {n.dismissed && <DismissedBadge />}
          {!n.read && <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-label="Unread" />}
        </div>
        <p className="mt-0.5 line-clamp-3 break-words text-xs text-muted-foreground">{n.message}</p>
        <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-muted-foreground/80">
          <time dateTime={new Date(at).toISOString()} title={new Date(at).toLocaleString()}>{formatDistanceToNow(new Date(at))}</time>
          {serverName && <span>{serverName}</span>}
          {n.dismissed && canRestore && (
            <button type="button" onClick={onRestore} className="inline-flex items-center gap-1 text-primary hover:underline">
              <RotateCcw className="size-3" aria-hidden /> Restore to bell
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

function TaskStatusIcon({ status }: { status: Task['status'] }) {
  if (status === 'running') return <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-primary motion-reduce:animate-none" aria-label="Running" />;
  if (status === 'success') return <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" aria-label="Done" />;
  if (status === 'cancelled') return <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-label="Cancelled" />;
  return <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-label="Failed" />;
}

const STATUS_TEXT: Record<Task['status'], string> = { running: 'Running', success: 'Done', error: 'Failed', cancelled: 'Cancelled', lost: 'Lost track of' };

function TaskRow({
  task,
  seen,
  canRestore,
  onSeen,
  onRestore,
}: {
  task: Task;
  seen: boolean;
  canRestore: boolean;
  onSeen: (ids: string[]) => void;
  onRestore: () => void;
}) {
  const [logOpen, setLogOpen] = useState(false);
  const at = task.finishedAt ?? task.startedAt;
  return (
    <li className={cn('flex items-start gap-3 border-b px-4 py-3 last:border-b-0', task.dismissed && 'bg-muted/40')}>
      <TaskStatusIcon status={task.status} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 truncate text-sm font-medium">{task.actionLabel} <span className="font-normal text-muted-foreground">on {task.serverName}</span></span>
          {task.dismissed && <DismissedBadge />}
          {!seen && <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-label="Unread" />}
        </div>
        <p className="mt-0.5 line-clamp-3 break-words text-xs text-muted-foreground">
          {STATUS_TEXT[task.status]}{task.message ? `: ${task.message}` : ''}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-muted-foreground/80">
          <time dateTime={new Date(at).toISOString()} title={new Date(at).toLocaleString()}>{formatDistanceToNow(new Date(at))}</time>
          <span>{task.serverName}</span>
          <button type="button" className="text-primary hover:underline" onClick={() => { setLogOpen(true); onSeen([task.id]); }}>Log</button>
          {task.screenId && task.widgetId && (
            <Link
              href={`/widgets/${encodeURIComponent(task.widgetId)}/${encodeURIComponent(task.screenId)}?job=${encodeURIComponent(task.id)}`}
              onClick={() => onSeen([task.id])}
              className="inline-flex items-center gap-1 text-primary hover:underline"
            >
              Open the screen <SquareArrowOutUpRight className="size-3" aria-hidden />
            </Link>
          )}
          {task.dismissed && canRestore && (
            <button type="button" onClick={onRestore} className="inline-flex items-center gap-1 text-primary hover:underline">
              <RotateCcw className="size-3" aria-hidden /> Restore to bell
            </button>
          )}
        </div>
      </div>
      <LogDialog task={logOpen ? task : null} onClose={() => setLogOpen(false)} />
    </li>
  );
}

/**
 * The log behind the bell: every notification (including dismissed ones) and finished task, with
 * filters, search and pages of older items. Dismissed rows can be put back in the bell.
 */
export default function ActivityPage() {
  const { user } = useAuth();
  const canRestore = hasRole(user?.role, 'operator');
  const { tasks, seen, markSeen, restoreTask } = useTasks(false);
  const { fetchNotifications } = useNotifications();
  const [notifications, setNotifications] = useState<HistoryNotification[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [type, setType] = useState<TypeFilter>('all');
  const [serverId, setServerId] = useState('');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [servers, setServers] = useState<{ id: string; name: string }[]>([]);

  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    fetchWithAuth('/api/servers')
      .then(r => readJson<{ data?: { servers?: { id: string; name: string }[] } }>(r))
      .then(j => setServers(ensureArray<{ id: string; name: string }>(j?.data?.servers).map(s => ({ id: String(s.id), name: String(s.name) }))))
      .catch(() => setServers([]));
  }, []);

  const paramsFor = (before?: string | null) => {
    const params = new URLSearchParams({ history: '1', limit: '25' });
    if (type !== 'all' && type !== 'tasks') params.set('kind', type);
    if (serverId) params.set('server', serverId);
    if (unreadOnly) params.set('unread', 'true');
    if (query) params.set('q', query);
    if (before) params.set('before', before);
    return params;
  };

  useEffect(() => {
    if (type === 'tasks') {
      setNotifications([]);
      setNextBefore(null);
      setError(null);
      setLoading(false);
      return;
    }
    let ignore = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await fetchWithAuth(`/api/notifications?${paramsFor().toString()}`);
        const json = await readJson<{ data?: { notifications?: HistoryNotification[]; nextBefore?: string | null }; error?: { message?: string } }>(res);
        if (!res.ok) throw new Error(json.error?.message || `HTTP ${res.status}`);
        if (!ignore) {
          setNotifications(json.data?.notifications ?? []);
          setNextBefore(json.data?.nextBefore ?? null);
        }
      } catch (e) {
        if (!ignore) {
          setError(e instanceof Error ? e.message : String(e));
          setNotifications([]);
          setNextBefore(null);
        }
      } finally {
        if (!ignore) setLoading(false);
      }
    })();
    return () => { ignore = true; };
    // paramsFor is derived from these values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, serverId, unreadOnly, query]);

  const loadMore = async () => {
    if (!nextBefore || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await fetchWithAuth(`/api/notifications?${paramsFor(nextBefore).toString()}`);
      const json = await readJson<{ data?: { notifications?: HistoryNotification[]; nextBefore?: string | null }; error?: { message?: string } }>(res);
      if (!res.ok) throw new Error(json.error?.message || `HTTP ${res.status}`);
      setNotifications(prev => {
        const known = new Set(prev.map(n => n.id));
        return [...prev, ...(json.data?.notifications ?? []).filter(n => !known.has(n.id))];
      });
      setNextBefore(json.data?.nextBefore ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingMore(false);
    }
  };

  const restoreNotification = async (id: string) => {
    try {
      const res = await fetchWithAuth(`/api/notifications/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dismissed: false }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setNotifications(prev => prev.map(n => (n.id === id ? { ...n, dismissed: false, read: false } : n)));
      await fetchNotifications();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const serverMap = useMemo(() => new Map(servers.map(s => [s.id, s.name])), [servers]);
  const items = useMemo(() => {
    const list: ActivityItem[] = [];
    if (type !== 'tasks') {
      for (const n of notifications) {
        if (type === 'alerts' && n.kind !== 'alert') continue;
        if (type === 'update' && !UPDATE_KINDS.has(n.kind)) continue;
        if (type === 'access' && !ACCESS.has(n.kind)) continue;
        if (serverId && n.server_id !== serverId) continue;
        if (unreadOnly && n.read) continue;
        if (query && !`${n.title}\n${n.message}`.toLowerCase().includes(query.toLowerCase())) continue;
        list.push({ type: 'notification', at: notificationTime(n.created_at), notification: n });
      }
    }
    if (type === 'all' || type === 'tasks') {
      for (const t of tasks) {
        if (t.status === 'running') continue;
        if (serverId && t.serverId !== serverId) continue;
        if (unreadOnly && seen.has(t.id)) continue;
        if (query && !`${t.actionLabel}\n${t.message ?? ''}`.toLowerCase().includes(query.toLowerCase())) continue;
        list.push({ type: 'task', at: taskTime(t), task: t });
      }
    }
    return list.sort((a, b) => b.at - a.at);
  }, [notifications, tasks, type, serverId, unreadOnly, query, seen]);

  return (
    <>
      <Header title="Activity" />
      <div className="page mx-auto w-full max-w-4xl space-y-4">
        <p className="text-sm text-muted-foreground">
          Everything the bell has shown, including items you dismissed. Dismissed items stay here and can be put back in the bell.
        </p>

        <div className="flex flex-wrap items-end gap-3 rounded-xl border bg-card p-3">
          <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
            Type
            <select value={type} onChange={e => setType(e.target.value as TypeFilter)} className="form-select w-40">
              {TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
            Server
            <select value={serverId} onChange={e => setServerId(e.target.value)} className="form-select w-48">
              <option value="">All servers</option>
              {servers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <label className="flex h-9 items-center gap-2 text-sm">
            <input type="checkbox" checked={unreadOnly} onChange={e => setUnreadOnly(e.target.checked)} className="size-4 rounded border-input text-primary focus-visible:ring-2 focus-visible:ring-ring" />
            Unread only
          </label>
          <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs font-medium text-muted-foreground">
            Search
            <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search title or message" aria-label="Search activity" />
          </label>
        </div>

        {error && <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}

        <div className="overflow-hidden rounded-xl border bg-card">
          {loading ? (
            <p className="p-6 text-center text-sm text-muted-foreground">Loading…</p>
          ) : items.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">No activity matches these filters.</p>
          ) : (
            <ul className="divide-y divide-border">
              {items.map(item => item.type === 'notification' ? (
                <NotificationRow
                  key={`n:${item.notification.id}`}
                  n={item.notification}
                  serverName={item.notification.server_id ? serverMap.get(item.notification.server_id) ?? 'a server' : null}
                  canRestore={canRestore}
                  onRestore={() => restoreNotification(item.notification.id)}
                />
              ) : (
                <TaskRow
                  key={`t:${item.task.id}`}
                  task={item.task}
                  seen={seen.has(item.task.id)}
                  canRestore
                  onSeen={markSeen}
                  onRestore={() => restoreTask(item.task.id)}
                />
              ))}
            </ul>
          )}
        </div>

        {nextBefore && type !== 'tasks' && (
          <div className="flex justify-center">
            <Button variant="outline" onClick={loadMore} disabled={loadingMore}>
              {loadingMore ? 'Loading…' : 'Load more'}
            </Button>
          </div>
        )}
      </div>
    </>
  );
}
