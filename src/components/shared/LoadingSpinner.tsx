import { cn } from '@/lib/utils';

export function LoadingSpinner({ className, label = 'Loading' }: { className?: string; label?: string }) {
  return (
    <div className={cn('flex items-center justify-center p-8', className)} role="status" aria-label={label}>
      <div className="size-8 animate-spin rounded-full border-4 border-muted border-t-primary motion-reduce:animate-none" />
    </div>
  );
}
