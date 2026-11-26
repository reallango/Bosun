import { useState, useEffect, useCallback, useRef } from 'react';
import { Dashboard, GridBreakpoint, LayoutItem, LayoutUpdateMode } from '@/types/dashboard';
import { applyLayoutEdit, applyLayoutEverywhere, resetLayoutAt, type LayoutEditResult } from '@/lib/widget-sizes';
import { Widget } from '@/types/widget';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import { readJson } from '@/lib/api/readJson';
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
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const json = await readJson<any>(res);
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
     * Persist the layout of the breakpoint the user edited: it is saved for that size and (on multi-column sizes) becomes
     * the base layout that sizes nobody arranged follow (see applyLayoutEdit in widget-sizes.ts).
     */
    const updateLayout = useCallback((breakpoint: GridBreakpoint, layout: LayoutItem[]) => {
        if (!dashboardId || layout.length === 0) return;

        // Keep local state in sync so a re-render does not snap widgets back.
        setWidgets(prev => prev.map(w => {
            const item = layout.find(l => l.widgetId === w.id);
            if (!item) return w;
            return withLayout(w, applyLayoutEdit(w.layouts, breakpoint, { x: item.x, y: item.y, w: item.w, h: item.h }));
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

    /**
     * Layout actions of the editor: `everywhere` uses the current size's arrangement on every size, `reset` makes the
     * current size follow the base layout again. Saved at once (no debounce), then the dashboard is reloaded.
     */
    const applyLayoutMode = useCallback(async (breakpoint: GridBreakpoint, mode: Exclude<LayoutUpdateMode, 'edit'>, layout?: LayoutItem[]) => {
        if (!dashboardId) return;
        const pending = layoutTimers.current[breakpoint];
        if (pending) { clearTimeout(pending); delete layoutTimers.current[breakpoint]; }
        setWidgets(prev => prev.map(w => {
            if (mode === 'reset') return { ...w, layouts: resetLayoutAt(w.layouts, breakpoint) };
            const item = layout?.find(l => l.widgetId === w.id);
            return item ? withLayout(w, applyLayoutEverywhere(breakpoint, { x: item.x, y: item.y, w: item.w, h: item.h })) : w;
        }));
        try {
            const res = await fetchWithAuth(`/api/dashboards/${dashboardId}/layout`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ breakpoint, mode, ...(layout ? { layout } : {}) }),
            });
            if (!res.ok) {
                const json = await res.json().catch(() => null);
                throw new Error(json?.error?.message || `HTTP ${res.status}`);
            }
            setLayoutError(null);
        } catch (err) {
            setLayoutError(err instanceof Error ? err.message : 'Failed to save layout');
        }
        await fetchDashboard();
    }, [dashboardId, fetchDashboard]);

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
        applyLayoutMode,
        refresh: fetchDashboard,
    };
}

/** A widget with the result of a layout edit applied (what the server stores), so the grid does not snap back. */
function withLayout(w: Widget, r: LayoutEditResult): Widget {
    const next: Widget = { ...w, layouts: r.layouts };
    if (r.grid) Object.assign(next, { grid_x: r.grid.x, grid_y: r.grid.y, grid_w: r.grid.w, grid_h: r.grid.h });
    return next;
}
