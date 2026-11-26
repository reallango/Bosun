'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Popover } from 'radix-ui';
import { Bell, Loader2, X } from 'lucide-react';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import { readJson } from '@/lib/api/readJson';
import { useTasks } from '@/hooks/useTasks';
import { TaskItem } from './TasksSection';
import { useNotifications, type Notification } from '@/providers/NotificationProvider';
import { useAuth } from '@/hooks/useAuth';
import { hasRole } from '@/lib/auth/levels';
import { formatDistanceToNow } from '@/lib/utils/date';
import { cn } from '@/lib/utils';
import { bellItemKey, groupBell, notificationTime, type BellItem } from '@/lib/notifications/bell';
import { notificationIcon } from './notificationIcon';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-b last:border-b-0">
      <h2 className="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
      {children}
    </section>
  );
}

function NotificationRow({
  n,
  quiet = false,
  canDecide,
  deciding,
  decisionError,
  onOpen,
  onDismiss,
  onDecide,
}: {
  n: Notification;
  quiet?: boolean;
  canDecide: boolean;
  deciding: boolean;
  decisionError: string | null;
  onOpen: () => void;
  onDismiss: () => void;
  onDecide: (decision: 'approve' | 'deny') => void;
}) {
  const t = notificationIcon(n.kind, n.type);
  const at = notificationTime(n.created_at);
  return (
    <div className={cn('group relative flex flex-col border-b last:border-b-0 hover:bg-accent/60', !n.read && !quiet && 'bg-primary/5', quiet && 'opacity-75')}>
      <button
        type="button"
        className="flex min-w-0 flex-1 items-start gap-2 p-3 pr-9 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        onClick={onOpen}
      >
        <t.icon className={cn('mt-0.5 size-4 shrink-0', t.className)} aria-hidden />
        <div className="min-w-0 flex-1">
          <div className={cn('truncate text-sm', quiet ? 'font-normal' : 'font-medium')}>{n.title}</div>
          <div className="line-clamp-3 text-xs text-muted-foreground">{n.message}</div>
          <div className="mt-1 text-xs text-muted-foreground/80">
            {formatDistanceToNow(new Date(at))}
          </div>
        </div>
      </button>
      {canDecide && n.kind === 'access_request' && n.request_id && (
        <div className="-mt-1 flex flex-wrap items-center gap-2 px-3 pb-2 pl-9 text-xs">
          <button type="button" disabled={deciding} onClick={() => onDecide('approve')}
            className="rounded-md bg-primary px-2 py-1 font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">Approve</button>
          <button type="button" disabled={deciding} onClick={() => onDecide('deny')}
            className="rounded-md border px-2 py-1 hover:bg-accent disabled:opacity-50">Deny</button>
          <button type="button" className="text-primary hover:underline" onClick={onOpen}>Details</button>
          {deciding && <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" aria-label="Working" />}
          {decisionError && <span role="alert" className="w-full text-destructive">{decisionError}</span>}
        </div>
      )}
      {canDecide && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label={`Dismiss: ${n.title}`}
          className="absolute right-1.5 top-2 inline-flex size-7 items-center justify-center rounded-md text-muted-foreground opacity-60 hover:bg-accent hover:text-foreground hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
}

/**
 * The bell: one panel with what needs attention, what is running, what is new and what was read
 * recently. One action marks every notification read and every finished task seen; dismissed items
 * leave the bell and stay on the Activity page.
 */
export function NotificationBell() {
  const { notifications, loading, fetchNotifications, markAsRead, markAllAsRead, dismiss } = useNotifications();
  const [isOpen, setIsOpen] = useState(false);
  const { tasks, running, unseen, seen, markSeen, dismissTask, reload } = useTasks(isOpen);
  const { user } = useAuth();
  const router = useRouter();
  const canDismiss = hasRole(user?.role, 'operator');
  const groups = useMemo(() => groupBell({ notifications, tasks, seen }), [notifications, tasks, seen]);
  const badge = groups.counts.badge;
  const hasAnything = groups.attention.length + groups.running.length + groups.newItems.length + groups.earlier.length > 0;
  const showMarkAll = groups.counts.unread > 0 || groups.counts.unseen > 0;

  // Access requests: approve or deny right here (the server checks the approver holds the permission).
  const [deciding, setDeciding] = useState<string | null>(null);
  const [decisionError, setDecisionError] = useState<{ id: string; message: string } | null>(null);
  const decide = async (n: Notification, decision: 'approve' | 'deny') => {
    if (!n.request_id) return;
    setDeciding(n.id); setDecisionError(null);
    try {
      const res = await fetchWithAuth(`/api/access-requests/${encodeURIComponent(n.request_id)}/decision`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision }),
      });
      const json = await readJson<{ error?: { message?: string } }>(res);
      if (!res.ok) setDecisionError({ id: n.id, message: json.error?.message || `HTTP ${res.status}` });
      else await fetchNotifications();
    } catch (e) {
      setDecisionError({ id: n.id, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setDeciding(null);
    }
  };

  useEffect(() => {
    fetchNotifications();
  }, [fetchNotifications]);

  // Fresh list whenever the bell is opened.
  useEffect(() => {
    if (isOpen) void fetchNotifications();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const open = (n: Notification) => {
    if (!n.read) void markAsRead(n.id);
    if (n.link) { setIsOpen(false); router.push(n.link); }
  };

  const markEverythingRead = async () => {
    await markAllAsRead();
    markSeen(tasks.filter(t => t.status !== 'running' && !t.dismissed).map(t => t.id));
  };

  const renderItem = (item: BellItem, quiet = false) => {
    if (item.type === 'task') {
      const task = tasks.find(t => t.id === item.task.id);
      if (!task) return null;
      return (
        <TaskItem
          key={bellItemKey(item)}
          task={task}
          seen={seen.has(task.id)}
          onSeen={markSeen}
          onNavigate={() => setIsOpen(false)}
          onDismiss={dismissTask}
          onChanged={reload}
          quiet={quiet}
        />
      );
    }
    const n = notifications.find(x => x.id === item.notification.id);
    if (!n) return null;
    return (
      <NotificationRow
        key={bellItemKey(item)}
        n={n}
        quiet={quiet}
        canDecide={canDismiss}
        deciding={deciding === n.id}
        decisionError={decisionError?.id === n.id ? decisionError.message : null}
        onOpen={() => open(n)}
        onDismiss={() => { if (canDismiss) void dismiss(n.id); }}
        onDecide={decision => decide(n, decision)}
      />
    );
  };

  return (
    <Popover.Root open={isOpen} onOpenChange={setIsOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="relative inline-flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={badge > 0 ? `Activity (${badge} unread)` : running > 0 ? `Activity (${running} task${running === 1 ? '' : 's'} running)` : 'Activity'}
        >
          <Bell className="size-[18px]" />
          {badge > 0 ? (
            <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-none text-destructive-foreground">
              {badge > 9 ? '9+' : badge}
            </span>
          ) : running > 0 ? (
            <span className="absolute right-0.5 top-0.5 flex size-4 items-center justify-center rounded-full bg-primary text-primary-foreground" aria-hidden>
              <Loader2 className="size-3 animate-spin motion-reduce:animate-none" />
            </span>
          ) : unseen > 0 ? (
            <span className="absolute right-1.5 top-1.5 size-2 rounded-full bg-primary" aria-hidden />
          ) : null}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          collisionPadding={8}
          className="z-50 w-[min(24rem,calc(100vw-1rem))] overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-lg"
        >
          <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
            <span className="text-sm font-semibold">Activity</span>
            <div className="flex items-center gap-3">
              {showMarkAll && (
                <button type="button" onClick={markEverythingRead} className="text-xs text-primary hover:underline">
                  Mark all as read
                </button>
              )}
              <Link href="/activity" onClick={() => setIsOpen(false)} className="text-xs text-primary hover:underline">
                View all
              </Link>
            </div>
          </div>
          <div className="max-h-[min(32rem,70dvh)] overflow-y-auto">
            {loading && notifications.length === 0 && tasks.length === 0 ? (
              <div className="p-4 text-center text-sm text-muted-foreground">Loading…</div>
            ) : !hasAnything ? (
              <div className="p-4 text-center text-sm text-muted-foreground">No activity</div>
            ) : (
              <>
                {groups.attention.length > 0 && (
                  <Section title="Needs your attention">
                    {groups.attention.map(item => renderItem(item))}
                  </Section>
                )}
                {groups.running.length > 0 && (
                  <Section title="Running">
                    {groups.running.map(item => renderItem(item))}
                  </Section>
                )}
                {groups.newItems.length > 0 && (
                  <Section title="New">
                    {groups.newItems.map(item => renderItem(item))}
                  </Section>
                )}
                {groups.earlier.length > 0 && (
                  <Section title="Earlier">
                    {groups.earlier.map(item => renderItem(item, true))}
                  </Section>
                )}
              </>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
