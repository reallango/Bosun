'use client';

import type { JobState } from '@/lib/widgets/runtime/layout';
import { cn } from '@/lib/utils';

/** A thin bar under the header while a job runs; a job without a percentage shows an indeterminate stripe. */
export function JobProgressBar({ job, label }: { job: JobState | null; label?: string }) {
  if (!job || job.status !== 'running') return null;

  const percent = job.percent === null ? null : Math.min(100, Math.max(0, job.percent));
  return (
    <div
      role="progressbar"
      aria-label={label ? `${label} progress` : 'Job progress'}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent ?? undefined}
      aria-valuetext={job.message ?? undefined}
      className="w-full border-b border-border bg-muted/40"
    >
      <div className="h-1 w-full overflow-hidden bg-muted">
        <div
          className={cn(
            'h-full bg-primary transition-[width] duration-300 motion-reduce:transition-none',
            percent === null && 'w-1/3 animate-pulse motion-reduce:animate-none',
          )}
          style={percent === null ? undefined : { width: `${percent}%` }}
        />
      </div>
    </div>
  );
}
