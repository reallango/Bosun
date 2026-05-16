'use client';
import { useWidgetData } from '@/hooks/useWidgetData';

export function NetworkWidget({ widgetId }: { widgetId: string }) {
    const { data, isLoading, error } = useWidgetData(widgetId, 30);
    if (isLoading) return <div className="p-4 text-sm text-muted-foreground">Loading...</div>;
    if (error) return <div className="p-4 text-sm text-red-500">Error: {error}</div>;
    const interfaces = (Array.isArray(data) ? data : []) as any[];
    return (
        <div className="p-4 space-y-3 text-sm">
            {interfaces.map((iface, i) => (
                <div key={i} className="border-b border-border pb-2 last:border-0">
                    <div className="flex justify-between">
                        <span className="font-medium">{iface.name}</span>
                        <span className={`text-xs ${iface.state === 'UP' ? 'text-green-600' : 'text-gray-500'}`}>{iface.state}</span>
                    </div>
                    {iface.ipv4?.map((ip: string, j: number) => <div key={j} className="text-xs text-muted-foreground">{ip}</div>)}
                    {iface.macAddress && <div className="text-xs text-muted-foreground">{iface.macAddress}</div>}
                </div>
            ))}
            {interfaces.length === 0 && <div className="text-muted-foreground">No network data</div>}
        </div>
    );
}