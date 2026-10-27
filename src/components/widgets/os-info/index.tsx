'use client';
import { useState } from 'react';
import { PackageSearch } from 'lucide-react';
import { useWidgetData } from '@/hooks/useWidgetData';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import { WidgetError } from '@/components/widgets/WidgetError';
import { WidgetLoading } from '@/components/widgets/WidgetLoading';
import { WidgetPlaceholder } from '@/components/widgets/WidgetPlaceholder';

/* eslint-disable @typescript-eslint/no-explicit-any */
export function OSInfoWidget({ widgetId, serverId }: { widgetId: string; serverId: string }) {
    const { data, isLoading, error, refresh } = useWidgetData(widgetId, 60);
    const [checking, setChecking] = useState(false);
    const [updates, setUpdates] = useState<number | null>(null);

    const checkUpdates = async () => {
        setChecking(true);
        try {
            const res = await fetchWithAuth(`/api/servers/${serverId}/updates/check`, { method: 'POST' });
            const json = await res.json();
            setUpdates(json.data?.updatesAvailable ?? 0);
        } catch { setUpdates(null); }
        finally { setChecking(false); }
    };

    if (isLoading) return <WidgetLoading />;
    if (error) return <WidgetError error={error} onRetry={refresh} />;
    if ((data as any)?.source === 'placeholder') return <WidgetPlaceholder />;
    const d = data as any;
    const rows: [string, string][] = [
        ['OS', d?.prettyName || d?.name || 'Unknown'],
        ['Kernel', d?.kernel || '-'],
        ['Arch', d?.architecture || '-'],
        ['Hostname', d?.hostname || '-'],
        ['Uptime', d?.uptime || '-'],
    ];
    return (
        <div className="flex flex-col gap-3 text-sm">
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 @xl:grid-cols-[auto_minmax(0,1fr)_auto_minmax(0,1fr)]">
                {rows.map(([k, v]) => (
                    <div key={k} className="contents">
                        <dt className="text-muted-foreground">{k}</dt>
                        <dd className="truncate" title={v}>{v}</dd>
                    </div>
                ))}
            </dl>
            <button
                type="button"
                onClick={checkUpdates}
                disabled={checking}
                className="inline-flex w-fit items-center gap-1.5 rounded-md bg-primary/10 px-2.5 py-1 text-xs text-primary transition-colors hover:bg-primary/20 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
                <PackageSearch className="size-3.5" aria-hidden />
                {checking ? 'Checking…' : `Check updates${updates !== null ? ` (${updates})` : ''}`}
            </button>
        </div>
    );
}
