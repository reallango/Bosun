'use client';
import { useWidgetData } from '@/hooks/useWidgetData';
import { WidgetError } from '@/components/widgets/WidgetError';
import { WidgetLoading } from '@/components/widgets/WidgetLoading';
import { WidgetEmpty, WidgetPlaceholder } from '@/components/widgets/WidgetPlaceholder';
import { cn } from '@/lib/utils';

/* eslint-disable @typescript-eslint/no-explicit-any */
export function NetworkWidget({ widgetId }: { widgetId: string }) {
    const { data, isLoading, error, refresh } = useWidgetData(widgetId, 30);
    if (isLoading) return <WidgetLoading />;
    if (error) return <WidgetError error={error} onRetry={refresh} />;
    if ((data as any)?.source === 'placeholder') return <WidgetPlaceholder />;
    const interfaces = (Array.isArray(data) ? data : []) as any[];
    if (interfaces.length === 0) return <WidgetEmpty>No network data</WidgetEmpty>;
    return (
        <ul className="grid grid-cols-1 gap-2 text-sm @xl:grid-cols-2 @4xl:grid-cols-3">
            {interfaces.map((iface, i) => {
                const up = iface.state === 'UP';
                return (
                    <li key={iface.name ?? i} className="min-w-0 rounded-lg border bg-muted/30 px-2.5 py-2">
                        <div className="flex items-center justify-between gap-2">
                            <span className="min-w-0 truncate font-medium">{iface.name}</span>
                            <span className={cn('inline-flex shrink-0 items-center gap-1 text-xs', up ? 'text-success' : 'text-muted-foreground')}>
                                <span className={cn('size-1.5 rounded-full', up ? 'bg-green-500' : 'bg-gray-400')} aria-hidden />
                                {iface.state}
                            </span>
                        </div>
                        {iface.ipv4?.map((ip: string, j: number) => (
                            <div key={j} className="truncate font-mono text-xs text-muted-foreground">
                                {ip}
                            </div>
                        ))}
                        {iface.macAddress && (
                            <div className="hidden truncate font-mono text-xs text-muted-foreground/80 @[14rem]:block">{iface.macAddress}</div>
                        )}
                    </li>
                );
            })}
        </ul>
    );
}
