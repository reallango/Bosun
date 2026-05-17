'use client';
import { useState } from 'react';
import { useWidgetData } from '@/hooks/useWidgetData';
import { WidgetError } from '@/components/widgets/WidgetError';
import { WidgetLoading } from '@/components/widgets/WidgetLoading';
import { WidgetPlaceholder } from '@/components/widgets/WidgetPlaceholder';
import { StatusBadge } from '@/components/shared/StatusBadge';

export function SystemServicesWidget({ widgetId, serverId }: { widgetId: string; serverId: string }) {
    const { data, isLoading, error, refresh } = useWidgetData(widgetId, 30);
    const [filter, setFilter] = useState('');
    if (isLoading) return <WidgetLoading />;
    if (error) return <WidgetError error={error} onRetry={refresh} />;
    if ((data as any)?.source === 'placeholder') return <WidgetPlaceholder />;
    const svcs = (Array.isArray(data) ? data : []) as any[];
    const filtered = filter ? svcs.filter(s => s.name.toLowerCase().includes(filter.toLowerCase())) : svcs;
    return (
        <div className="p-4 space-y-2 text-sm">
            <input placeholder="Filter services..." value={filter} onChange={e => setFilter(e.target.value)}
                className="w-full px-2 py-1 text-xs border rounded bg-transparent" />
            <div className="max-h-48 overflow-y-auto space-y-1">
                {filtered.map((s, i) => (
                    <div key={i} className="flex items-center justify-between py-1">
                        <div className="flex items-center gap-2">
                            <StatusBadge status={s.status === 'running' ? 'running' : 'stopped'} />
                            <span className="text-xs">{s.name}</span>
                        </div>
                        <span className="text-xs text-muted-foreground truncate max-w-[120px]">{s.description}</span>
                    </div>
                ))}
                {filtered.length === 0 && <div className="text-muted-foreground text-xs">No services</div>}
            </div>
        </div>
    );
}