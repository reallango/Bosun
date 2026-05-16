import { useState, useEffect, useCallback, useRef } from 'react';
import { Dashboard, LayoutItem } from '@/types/dashboard';
import { Widget } from '@/types/widget';

export function useDashboard(dashboardId: string) {
    const [dashboard, setDashboard] = useState<Dashboard | null>(null);
    const [widgets, setWidgets] = useState<Widget[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const layoutTimer = useRef<NodeJS.Timeout | null>(null);

    const fetchDashboard = useCallback(async () => {
        if (!dashboardId) return;
        try {
            const res = await fetch(`/api/dashboards/${dashboardId}`);
            const json = await res.json();
            if (json.data) {
                setDashboard(json.data.dashboard);
                setWidgets(json.data.widgets || []);
            }
            setError(null);
        } catch (err) { setError(String(err)); }
        finally { setIsLoading(false); }
    }, [dashboardId]);

    useEffect(() => { fetchDashboard(); }, [fetchDashboard]);

    const updateLayout = useCallback((layout: LayoutItem[]) => {
        if (layoutTimer.current) clearTimeout(layoutTimer.current);
        layoutTimer.current = setTimeout(async () => {
            try {
                await fetch(`/api/dashboards/${dashboardId}/layout`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ layout }),
                });
            } catch {}
        }, 300);
    }, [dashboardId]);

    const addWidget = useCallback(async (widgetType: string, serverId: string) => {
        await fetch(`/api/dashboards/${dashboardId}/widgets`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ widget_type: widgetType, server_id: serverId }),
        });
        fetchDashboard();
    }, [dashboardId, fetchDashboard]);

    const removeWidget = useCallback(async (widgetId: string) => {
        await fetch(`/api/widgets/${widgetId}`, { method: 'DELETE' });
        fetchDashboard();
    }, [fetchDashboard]);

    return { dashboard, widgets, isLoading, error, addWidget, removeWidget, updateLayout, refresh: fetchDashboard };
}