'use client';
import { CircularGauge } from '@/components/shared/CircularGauge';
import { useWidgetData } from '@/hooks/useWidgetData';

export function CPUMemoryWidget({ widgetId }: { widgetId: string }) {
    const { data, isLoading, error } = useWidgetData(widgetId, 5);
    if (isLoading) return <div className="p-4 text-sm text-muted-foreground">Loading...</div>;
    if (error) return <div className="p-4 text-sm text-red-500">Error: {error}</div>;
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