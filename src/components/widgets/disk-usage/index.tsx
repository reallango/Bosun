'use client';
import { useWidgetData } from '@/hooks/useWidgetData';
import { WidgetError } from '@/components/widgets/WidgetError';
import { WidgetLoading } from '@/components/widgets/WidgetLoading';
import { WidgetPlaceholder } from '@/components/widgets/WidgetPlaceholder';

export function DiskUsageWidget({ widgetId }: { widgetId: string }) {
    const { data, isLoading, error, refresh } = useWidgetData(widgetId, 30);
    if (isLoading) return <WidgetLoading />;
    if (error) return <WidgetError error={error} onRetry={refresh} />;
    if ((data as any)?.source === 'placeholder') return <WidgetPlaceholder />;
    const disks = (Array.isArray(data) ? data : []) as any[];
    return (
        <div className="p-4 space-y-3 text-sm">
            {disks.map((d, i) => {
                const pct = d.usagePercent || 0;
                const color = pct > 85 ? 'bg-red-500' : pct > 70 ? 'bg-yellow-500' : 'bg-green-500';
                return (
                    <div key={i}>
                        <div className="flex justify-between text-xs mb-1">
                            <span>{d.mountPoint}</span>
                            <span>{d.usedMB} / {d.sizeMB} MB ({pct}%)</span>
                        </div>
                        <div className="w-full h-2 bg-gray-200 dark:bg-gray-700 rounded">
                            <div className={`h-full rounded ${color}`} style={{ width: `${pct}%` }} />
                        </div>
                    </div>
                );
            })}
            {disks.length === 0 && <div className="text-muted-foreground">No disk data</div>}
        </div>
    );
}