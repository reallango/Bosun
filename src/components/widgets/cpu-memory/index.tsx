'use client';
import { CircularGauge } from '@/components/shared/CircularGauge';
import { useWidgetData } from '@/hooks/useWidgetData';
import { WidgetError } from '@/components/widgets/WidgetError';
import { WidgetLoading } from '@/components/widgets/WidgetLoading';
import { WidgetPlaceholder } from '@/components/widgets/WidgetPlaceholder';
import { UsageBar } from '@/components/widgets/UsageBar';
import { formatMB, pct } from '@/components/widgets/format';

/* eslint-disable @typescript-eslint/no-explicit-any */
export function CPUMemoryWidget({ widgetId }: { widgetId: string }) {
    const { data, isLoading, error, refresh } = useWidgetData(widgetId, 5);
    if (isLoading) return <WidgetLoading />;
    if (error) return <WidgetError error={error} onRetry={refresh} />;
    if ((data as any)?.source === 'placeholder') return <WidgetPlaceholder />;
    const d = data as any;
    const cpu = d?.cpu || {};
    const mem = d?.memory || {};
    const cpuPct = pct(cpu.usagePercent);
    const memPct = pct(mem.usagePercent);
    const load = [cpu.loadAvg1, cpu.loadAvg5, cpu.loadAvg15]
        .map((v: unknown) => (typeof v === 'number' ? v.toFixed(2) : '–'))
        .join(' / ');

    const details = (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs @md:grid-cols-[auto_1fr_auto_1fr] @2xl:flex-1 @2xl:grid-cols-[auto_1fr]">
            <dt className="text-muted-foreground">Load</dt>
            <dd className="truncate tabular-nums">{load}</dd>
            <dt className="text-muted-foreground">RAM</dt>
            <dd className="truncate tabular-nums">
                {formatMB(mem.usedMB || 0)} / {formatMB(mem.totalMB || 0)}
            </dd>
            {mem.swapTotalMB > 0 && <dt className="text-muted-foreground">Swap</dt>}
            {mem.swapTotalMB > 0 && (
                <dd className="truncate tabular-nums">
                    {formatMB(mem.swapUsedMB || 0)} / {formatMB(mem.swapTotalMB)}
                </dd>
            )}
            {cpu.temperature ? <dt className="text-muted-foreground">Temp</dt> : null}
            {cpu.temperature ? <dd className="tabular-nums">{cpu.temperature}°C</dd> : null}
        </dl>
    );

    return (
        <div className="flex h-full flex-col gap-3">
            {/* Tiny tiles: compact bars */}
            <div className="space-y-2 @[13rem]:hidden">
                <div>
                    <div className="mb-1 flex justify-between text-xs">
                        <span>CPU</span>
                        <span className="tabular-nums">{Math.round(cpuPct)}%</span>
                    </div>
                    <UsageBar value={cpuPct} />
                </div>
                <div>
                    <div className="mb-1 flex justify-between text-xs">
                        <span>Memory</span>
                        <span className="tabular-nums">{Math.round(memPct)}%</span>
                    </div>
                    <UsageBar value={memPct} />
                </div>
            </div>

            {/* Larger tiles: gauges, details beside them (wide) or below */}
            <div className="hidden min-h-0 flex-1 gap-4 @[13rem]:flex @[13rem]:flex-col @2xl:flex-row @2xl:items-center">
                <div className="grid grid-cols-2 items-center justify-items-center gap-3 @2xl:flex-1">
                    <CircularGauge value={cpuPct} label="CPU" size={120} className="w-full" />
                    <CircularGauge value={memPct} label="Memory" size={120} className="w-full" />
                </div>
                {details}
            </div>
        </div>
    );
}
