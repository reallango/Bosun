'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Popover } from 'radix-ui';
import { Bell, CircleAlert, CircleCheck, Info, Loader2, PackageCheck, PackagePlus, TriangleAlert, X } from 'lucide-react';
import { useTasks } from '@/hooks/useTasks';
import { TasksSection } from './TasksSection';
import { useNotifications, type Notification } from '@/providers/NotificationProvider';
import { useAuth } from '@/hooks/useAuth';
import { hasRole } from '@/lib/auth/levels';
import { formatDistanceToNow } from '@/lib/utils/date';
import { cn } from '@/lib/utils';

const TYPE_ICON = {
  error: { icon: CircleAlert, className: 'text-destructive' },
  warning: { icon: TriangleAlert, className: 'text-warning' },
  success: { icon: CircleCheck, className: 'text-success' },
  info: { icon: Info, className: 'text-primary' },
} as const;

/** Kinds with their own icon; everything else uses the severity icon. */
const KIND_ICON: Record<string, { icon: typeof Info; className: string }> = {
  widget_update: { icon: PackagePlus, className: 'text-primary' },
  widget_upgraded: { icon: PackageCheck, className: 'text-success' },
};

export function NotificationBell() {
  const { notifications, unreadCount, loading, fetchNotifications, markAsRead, markAllAsRead, dismiss } = useNotifications();
  const [isOpen, setIsOpen] = useState(false);
  const { tasks, running, unseen, failedUnseen, seen, markSeen, reload } = useTasks(isOpen);
  const { user } = useAuth();
  const router = useRouter();
  const canDismiss = hasRole(user?.role, 'operator');
  const badge = unreadCount + failedUnseen;

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

  return (
    <Popover.Root open={isOpen} onOpenChange={setIsOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="relative inline-flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={badge > 0 ? `Notifications (${badge} unread)` : running > 0 ? `Notifications (${running} task${running === 1 ? '' : 's'} running)` : 'Notifications'}
        >
          <Bell className="size-[18px]" />
          {badge > 0 ? (
            <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold leading-none text-white">
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
          className="z-50 w-[min(22rem,calc(100vw-1rem))] overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-lg"
        >
          <div className="flex items-center justify-between border-b px-3 py-2">
            <span className="text-sm font-medium">Notifications</span>
            {unreadCount > 0 && (
              <button type="button" onClick={markAllAsRead} className="text-xs text-primary hover:underline">
                Mark all read
              </button>
            )}
          </div>
          <div className="max-h-[min(28rem,70dvh)] overflow-y-auto">
            <TasksSection tasks={tasks} seen={seen} markSeen={markSeen} onNavigate={() => setIsOpen(false)} reload={reload} />
            {loading ? (
              <div className="p-4 text-center text-sm text-muted-foreground">Loading…</div>
            ) : notifications.length === 0 ? (
              <div className="p-4 text-center text-sm text-muted-foreground">No notifications</div>
            ) : (
              notifications.slice(0, 20).map(n => {
                const t = KIND_ICON[n.kind] ?? TYPE_ICON[n.type as keyof typeof TYPE_ICON] ?? TYPE_ICON.info;
                return (
                  <div
                    key={n.id}
                    className={cn('group relative flex border-b last:border-b-0 hover:bg-accent/60', !n.read && 'bg-primary/5')}
                  >
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-start gap-2 p-3 pr-9 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                      onClick={() => open(n)}
                    >
                      <t.icon className={cn('mt-0.5 size-4 shrink-0', t.className)} aria-hidden />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">{n.title}</div>
                        <div className="line-clamp-3 text-xs text-muted-foreground">{n.message}</div>
                        <div className="mt-1 text-xs text-muted-foreground/80">
                          {formatDistanceToNow(new Date(n.created_at))}
                        </div>
                      </div>
                    </button>
                    {canDismiss && (
                      <button
                        type="button"
                        onClick={() => dismiss(n.id)}
                        aria-label={`Dismiss: ${n.title}`}
                        className="absolute right-1.5 top-2 inline-flex size-7 items-center justify-center rounded-md text-muted-foreground opacity-60 hover:bg-accent hover:text-foreground hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <X className="size-3.5" />
                      </button>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
