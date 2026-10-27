'use client';
import { useState } from 'react';
import { Search } from 'lucide-react';
import { useWidgetData } from '@/hooks/useWidgetData';
import { WidgetError } from '@/components/widgets/WidgetError';
import { WidgetLoading } from '@/components/widgets/WidgetLoading';
import { WidgetPlaceholder } from '@/components/widgets/WidgetPlaceholder';
import { StatusBadge } from '@/components/shared/StatusBadge';

interface Service {
    name: string;
    status?: string;
    description?: string;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function SystemServicesWidget({ widgetId, serverId }: { widgetId: string; serverId: string }) {
    const { data, isLoading, error, refresh } = useWidgetData(widgetId, 30);
    const [filter, setFilter] = useState('');
    if (isLoading) return <WidgetLoading />;
    if (error) return <WidgetError error={error} onRetry={refresh} />;
    if ((data as { source?: string } | null)?.source === 'placeholder') return <WidgetPlaceholder />;
    const svcs = (Array.isArray(data) ? data : []) as Service[];
    const q = filter.toLowerCase();
    const filtered = q ? svcs.filter(s => String(s.name ?? '').toLowerCase().includes(q)) : svcs;
    const running = svcs.filter(s => s.status === 'running').length;

    return (
        <div className="flex h-full min-h-0 flex-col gap-2 text-sm">
            <div className="flex items-center gap-2">
                <label className="relative min-w-0 flex-1">
                    <span className="sr-only">Filter services</span>
                    <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
                    <input
                        placeholder="Filter services…"
                        value={filter}
                        onChange={e => setFilter(e.target.value)}
                        className="no-drag h-8 w-full rounded-md border border-input bg-transparent pl-7 pr-2 text-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
                    />
                </label>
                <span className="hidden shrink-0 text-xs tabular-nums text-muted-foreground @[16rem]:inline">
                    {running}/{svcs.length} running
                </span>
            </div>
            <ul className="-mr-1 min-h-0 flex-1 divide-y overflow-y-auto pr-1">
                {filtered.map((s, i) => (
                    <li key={`${s.name}-${i}`} className="flex items-center gap-2 py-1.5">
                        <StatusBadge status={s.status === 'running' ? 'running' : 'stopped'} compact />
                        <span className="min-w-0 flex-1 truncate text-xs" title={s.name}>{s.name}</span>
                        {s.description && (
                            <span className="hidden min-w-0 max-w-[55%] truncate text-xs text-muted-foreground @md:inline" title={s.description}>
                                {s.description}
                            </span>
                        )}
                    </li>
                ))}
                {filtered.length === 0 && <li className="py-2 text-xs text-muted-foreground">No services</li>}
            </ul>
        </div>
    );
}
