import { cn } from '@/lib/utils';

interface StatusBadgeProps {
  status: 'online' | 'offline' | 'running' | 'stopped' | 'error' | 'unknown';
  /** Hide the text label (dot only); the label stays available to screen readers. */
  compact?: boolean;
  className?: string;
}

const CONFIG = {
  online: { color: 'bg-green-500', text: 'Online' },
  offline: { color: 'bg-red-500', text: 'Offline' },
  running: { color: 'bg-green-500', text: 'Running' },
  stopped: { color: 'bg-red-500', text: 'Stopped' },
  error: { color: 'bg-red-500', text: 'Error' },
  unknown: { color: 'bg-gray-400', text: 'Unknown' },
};

export function StatusBadge({ status, compact = false, className }: StatusBadgeProps) {
  const { color, text } = CONFIG[status] || CONFIG.unknown;

  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1.5 text-xs', className)} title={compact ? text : undefined}>
      <span className={cn('size-2 rounded-full', color)} aria-hidden />
      <span className={cn('text-muted-foreground', compact && 'sr-only')}>{text}</span>
    </span>
  );
}
