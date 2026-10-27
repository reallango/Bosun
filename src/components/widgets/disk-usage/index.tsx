'use client';
import { useWidgetData } from '@/hooks/useWidgetData';
import { WidgetError } from '@/components/widgets/WidgetError';
import { WidgetLoading } from '@/components/widgets/WidgetLoading';
import { WidgetEmpty, WidgetPlaceholder } from '@/components/widgets/WidgetPlaceholder';
import { UsageBar } from '@/components/widgets/UsageBar';
import { formatMB, pct } from '@/components/widgets/format';

/* eslint-disable @typescript-eslint/no-explicit-any */
export function DiskUsageWidget({ widgetId }: { widgetId: string }) {
    const { data, isLoading, error, refresh } = useWidgetData(widgetId, 30);
    if (isLoading) return <WidgetLoading />;
    if (error) return <WidgetError error={error} onRetry={refresh} />;
    if ((data as any)?.source === 'placeholder') return <WidgetPlaceholder />;
    const disks = (Array.isArray(data) ? data : []) as any[];
    if (disks.length === 0) return <WidgetEmpty>No disk data</WidgetEmpty>;
    return (
        <ul className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm @2xl:grid-cols-2 @5xl:grid-cols-3">
            {disks.map((d, i) => {
                const p = pct(d.usagePercent);
                return (
                    <li key={d.mountPoint ?? i} className="min-w-0">
                        <div className="mb-1 flex items-baseline justify-between gap-2 text-xs">
                            <span className="min-w-0 truncate font-medium" title={d.mountPoint}>
                                {d.mountPoint}
                            </span>
                            <span className="shrink-0 tabular-nums text-muted-foreground">
                                <span className="hidden @[16rem]:inline">
                                    {formatMB(d.usedMB)} / {formatMB(d.sizeMB)} ·{' '}
                                </span>
                                {Math.round(p)}%
                            </span>
                        </div>
                        <UsageBar value={p} className="h-2" />
                    </li>
                );
            })}
        </ul>
    );
}
