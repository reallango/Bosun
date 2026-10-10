'use client';
import { useWidgetData } from '@/hooks/useWidgetData';
import { WidgetError } from '@/components/widgets/WidgetError';
import { WidgetLoading } from '@/components/widgets/WidgetLoading';
import { WidgetPlaceholder } from '@/components/widgets/WidgetPlaceholder';

export function OSInfoWidget({ widgetId }: { widgetId: string; serverId: string }) {
    const { data, isLoading, error, refresh } = useWidgetData(widgetId, 60);

    if (isLoading) return <WidgetLoading />;
    if (error) return <WidgetError error={error} onRetry={refresh} />;
    if ((data as any)?.source === 'placeholder') return <WidgetPlaceholder />;
    const d = data as any;
    return (
        <div className="p-4 space-y-2 text-sm">
            <div><span className="text-muted-foreground">OS:</span> {d?.prettyName || d?.name || 'Unknown'}</div>
            <div><span className="text-muted-foreground">Kernel:</span> {d?.kernel || '-'}</div>
            <div><span className="text-muted-foreground">Arch:</span> {d?.architecture || '-'}</div>
            <div><span className="text-muted-foreground">Hostname:</span> {d?.hostname || '-'}</div>
            <div><span className="text-muted-foreground">Uptime:</span> {d?.uptime || '-'}</div>
        </div>
    );
}