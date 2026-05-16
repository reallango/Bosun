'use client';
import { useState } from 'react';
import { useWidgetData } from '@/hooks/useWidgetData';

export function OSInfoWidget({ widgetId, serverId }: { widgetId: string; serverId: string }) {
    const { data, isLoading, error } = useWidgetData(widgetId, 60);
    const [checking, setChecking] = useState(false);
    const [updates, setUpdates] = useState<number | null>(null);

    const checkUpdates = async () => {
        setChecking(true);
        try {
            const res = await fetch(`/api/servers/${serverId}/updates/check`, { method: 'POST' });
            const json = await res.json();
            setUpdates(json.data?.updatesAvailable ?? 0);
        } catch { setUpdates(null); }
        finally { setChecking(false); }
    };

    if (isLoading) return <div className="p-4 text-sm text-muted-foreground">Loading...</div>;
    if (error) return <div className="p-4 text-sm text-red-500">Error: {error}</div>;
    const d = data as any;
    return (
        <div className="p-4 space-y-2 text-sm">
            <div><span className="text-muted-foreground">OS:</span> {d?.prettyName || d?.name || 'Unknown'}</div>
            <div><span className="text-muted-foreground">Kernel:</span> {d?.kernel || '-'}</div>
            <div><span className="text-muted-foreground">Arch:</span> {d?.architecture || '-'}</div>
            <div><span className="text-muted-foreground">Hostname:</span> {d?.hostname || '-'}</div>
            <div><span className="text-muted-foreground">Uptime:</span> {d?.uptime || '-'}</div>
            <button onClick={checkUpdates} disabled={checking}
                className="mt-2 px-2 py-1 text-xs bg-primary/10 rounded hover:bg-primary/20">
                {checking ? 'Checking...' : `Check Updates${updates !== null ? ` (${updates})` : ''}`}
            </button>
        </div>
    );
}