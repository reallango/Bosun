import { useState, useEffect, useCallback, useRef } from 'react';
import { Dashboard, GridBreakpoint, LayoutItem } from '@/types/dashboard';
import { Widget } from '@/types/widget';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import { ensureArray } from '@/lib/api/ensureArray';

export function useDashboard(dashboardId: string) {
    const [dashboard, setDashboard] = useState<Dashboard | null>(null);
    const [widgets, setWidgets] = useState<Widget[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [layoutError, setLayoutError] = useState<string | null>(null);
    // One debounce timer per breakpoint so edits at different sizes never cancel each other.
    const layoutTimers = useRef<Partial<Record<GridBreakpoint, ReturnType<typeof setTimeout>>>>({});

    const fetchDashboard = useCallback(async () => {
        if (!dashboardId) return;
        try {
            const res = await fetchWithAuth(`/api/dashboards/${dashboardId}`);
            const json = await res.json();
            if (!res.ok || json?.error) throw new Error(json?.error?.message || `HTTP ${res.status}`);
            const dashboard = json?.data?.dashboard ?? json?.dashboard ?? null;
            const widgets = ensureArray<Widget>(json?.data?.widgets ?? json?.widgets);
            setDashboard(dashboard);
            setWidgets(widgets);
            setError(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
            setDashboard(null);
            setWidgets([]);
        }
        finally { setIsLoading(false); }
    }, [dashboardId]);

    useEffect(() => { fetchDashboard(); }, [fetchDashboard]);

    useEffect(() => {
        const timers = layoutTimers.current;
        return () => {
            Object.values(timers).forEach(t => t && clearTimeout(t));
        };
    }, []);

    /**
     * Persist the layout of the breakpoint the user edited. lg goes to grid_*,
     * anything else into the widget's per-breakpoint `layouts`.
     */
    const updateLayout = useCallback((breakpoint: GridBreakpoint, layout: LayoutItem[]) => {
        if (!dashboardId || layout.length === 0) return;

        // Keep local state in sync so a re-render does not snap widgets back.
        setWidgets(prev => prev.map(w => {
            const item = layout.find(l => l.widgetId === w.id);
            if (!item) return w;
            const rect = { x: item.x, y: item.y, w: item.w, h: item.h };
            if (breakpoint === 'lg') return { ...w, grid_x: rect.x, grid_y: rect.y, grid_w: rect.w, grid_h: rect.h };
            return { ...w, layouts: { ...(w.layouts ?? {}), [breakpoint]: rect } };
        }));

        const pending = layoutTimers.current[breakpoint];
        if (pending) clearTimeout(pending);
        layoutTimers.current[breakpoint] = setTimeout(async () => {
            delete layoutTimers.current[breakpoint];
            try {
                const res = await fetchWithAuth(`/api/dashboards/${dashboardId}/layout`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ breakpoint, layout }),
                });
                if (!res.ok) {
                    const json = await res.json().catch(() => null);
                    throw new Error(json?.error?.message || `HTTP ${res.status}`);
                }
                setLayoutError(null);
            } catch (err) {
                setLayoutError(err instanceof Error ? err.message : 'Failed to save layout');
            }
        }, 400);
    }, [dashboardId]);

    const addWidget = useCallback(async (widgetType: string, serverId: string, gridW?: number, gridH?: number) => {
        const res = await fetchWithAuth(`/api/dashboards/${dashboardId}/widgets`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ widget_type: widgetType, server_id: serverId, grid_w: gridW, grid_h: gridH }),
        });
        if (!res.ok) {
            const json = await res.json().catch(() => null);
            throw new Error(json?.error?.message || `Failed to add widget (HTTP ${res.status})`);
        }
        await fetchDashboard();
    }, [dashboardId, fetchDashboard]);

    const removeWidget = useCallback(async (widgetId: string) => {
        await fetchWithAuth(`/api/widgets/${widgetId}`, { method: 'DELETE' });
        fetchDashboard();
    }, [fetchDashboard]);

    return {
        dashboard,
        widgets,
        isLoading,
        error,
        layoutError,
        clearLayoutError: () => setLayoutError(null),
        addWidget,
        removeWidget,
        updateLayout,
        refresh: fetchDashboard,
    };
}
