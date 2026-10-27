'use client';

import { cn } from '@/lib/utils';
import { usageColor } from './format';

/** Thin horizontal usage bar (0-100). */
export function UsageBar({ value, className, colorClass }: { value: number; className?: string; colorClass?: string }) {
    const v = Math.max(0, Math.min(100, value || 0));
    return (
        <div
            className={cn('h-1.5 w-full overflow-hidden rounded-full bg-muted', className)}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(v)}
        >
            <div
                className={cn('h-full rounded-full transition-[width] duration-500 motion-reduce:transition-none', colorClass ?? usageColor(v))}
                style={{ width: `${v}%` }}
            />
        </div>
    );
}
