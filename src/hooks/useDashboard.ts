import { useState, useEffect, useCallback, useRef } from 'react';
import { Dashboard, LayoutItem } from '@/types/dashboard';
import { Widget } from '@/types/widget';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import { ensureArray } from '@/lib/api/ensureArray';
import { readJson } from '@/lib/api/readJson';

export function useDashboard(dashboardId: string) {
    const [dashboard, setDashboard] = useState<Dashboard | null>(null);
    const [widgets, setWidgets] = useState<Widget[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const layoutTimer = useRef<NodeJS.Timeout | null>(null);

    const fetchDashboard = useCallback(async () => {
        if (!dashboardId) return;
        try {
            const res = await fetchWithAuth(`/api/dashboards/${dashboardId}`);
            const json = await readJson<{ data?: { dashboard?: Dashboard; widgets?: Widget[] }; dashboard?: Dashboard; widgets?: Widget[] }>(res);
            const dashboard = json?.data?.dashboard ?? json?.dashboard ?? null;
            const widgets = ensureArray<Widget>(json?.data?.widgets ?? json?.widgets);
            setDashboard(dashboard);
            setWidgets(widgets);
            setError(null);
        } catch (err) { 
            setError(String(err)); 
            setDashboard(null);
            setWidgets([]);
        }
        finally { setIsLoading(false); }
    }, [dashboardId]);

    useEffect(() => { fetchDashboard(); }, [fetchDashboard]);

    const updateLayout = useCallback((layout: LayoutItem[]) => {
        if (layoutTimer.current) clearTimeout(layoutTimer.current);
        layoutTimer.current = setTimeout(async () => {
            try {
                await fetchWithAuth(`/api/dashboards/${dashboardId}/layout`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ layout }),
                });
            } catch {}
        }, 300);
    }, [dashboardId]);

    const addWidget = useCallback(async (widgetType: string, serverId: string, gridW?: number, gridH?: number) => {
        await fetchWithAuth(`/api/dashboards/${dashboardId}/widgets`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ widget_type: widgetType, server_id: serverId, grid_w: gridW, grid_h: gridH }),
        });
        fetchDashboard();
    }, [dashboardId, fetchDashboard]);

    const removeWidget = useCallback(async (widgetId: string) => {
        await fetchWithAuth(`/api/widgets/${widgetId}`, { method: 'DELETE' });
        fetchDashboard();
    }, [fetchDashboard]);

    return { dashboard, widgets, isLoading, error, addWidget, removeWidget, updateLayout, refresh: fetchDashboard };
}