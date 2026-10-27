'use client';
import { useWidgetData } from '@/hooks/useWidgetData';
import { WidgetError } from '@/components/widgets/WidgetError';
import { WidgetLoading } from '@/components/widgets/WidgetLoading';
import { WidgetPlaceholder } from '@/components/widgets/WidgetPlaceholder';

/* eslint-disable @typescript-eslint/no-explicit-any */
// Update detection lives in the OS Update Check widget (the old "Check
// updates" button here called a route that never existed).
export function OSInfoWidget({ widgetId }: { widgetId: string; serverId: string }) {
    const { data, isLoading, error, refresh } = useWidgetData(widgetId, 60);

    if (isLoading) return <WidgetLoading />;
    if (error) return <WidgetError error={error} onRetry={refresh} />;
    if (!data || (data as any)?.source === 'placeholder') return <WidgetPlaceholder />;
    const d = data as any;
    const rows: [string, string][] = [
        ['OS', d?.prettyName || d?.name || 'Unknown'],
        ['Kernel', d?.kernel || '-'],
        ['Arch', d?.architecture || '-'],
        ['Hostname', d?.hostname || '-'],
        ['Uptime', d?.uptime || '-'],
    ];
    return (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm @xl:grid-cols-[auto_minmax(0,1fr)_auto_minmax(0,1fr)]">
            {rows.map(([k, v]) => (
                <div key={k} className="contents">
                    <dt className="text-muted-foreground">{k}</dt>
                    <dd className="truncate" title={v}>{v}</dd>
                </div>
            ))}
        </dl>
    );
}
