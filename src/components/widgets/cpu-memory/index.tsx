'use client';
import { CircularGauge } from '@/components/shared/CircularGauge';
import { useWidgetData } from '@/hooks/useWidgetData';
import { WidgetError } from '@/components/widgets/WidgetError';
import { WidgetLoading } from '@/components/widgets/WidgetLoading';
import { WidgetPlaceholder } from '@/components/widgets/WidgetPlaceholder';

export function CPUMemoryWidget({ widgetId }: { widgetId: string }) {
    const { data, isLoading, error, refresh } = useWidgetData(widgetId, 5);
    if (isLoading) return <WidgetLoading />;
    if (error) return <WidgetError error={error} onRetry={refresh} />;
    if ((data as any)?.source === 'placeholder') return <WidgetPlaceholder />;
    const d = data as any;
    const cpu = d?.cpu || {};
    const mem = d?.memory || {};
    return (
        <div className="p-4">
            <div className="flex items-center justify-around">
                <CircularGauge value={cpu.usagePercent || 0} label="CPU" />
                <CircularGauge value={mem.usagePercent || 0} label="Memory" />
            </div>
            <div className="mt-3 text-xs text-muted-foreground space-y-1">
                <div>Load: {cpu.loadAvg1?.toFixed(2)} / {cpu.loadAvg5?.toFixed(2)} / {cpu.loadAvg15?.toFixed(2)}</div>
                <div>RAM: {mem.usedMB || 0} / {mem.totalMB || 0} MB</div>
                {mem.swapTotalMB > 0 && <div>Swap: {mem.swapUsedMB || 0} / {mem.swapTotalMB} MB</div>}
                {cpu.temperature && <div>Temp: {cpu.temperature}°C</div>}
            </div>
        </div>
    );
}