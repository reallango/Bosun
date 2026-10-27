'use client';

import { useEffect, useState } from 'react';
import type { Dashboard } from '@/types/dashboard';
import { Plus, TriangleAlert, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { LoadingSpinner } from '@/components/shared/LoadingSpinner';
import { ErrorState } from '@/components/shared/ErrorState';
import { useDashboard } from '@/hooks/useDashboard';
import { DashboardGrid } from './DashboardGrid';
import { DashboardToolbar } from './DashboardToolbar';
import { AddWidgetModal } from './AddWidgetModal';

interface DashboardViewProps {
  dashboardId: string;
  name: string;
  type: 'home' | 'server' | 'custom';
  serverId?: string;
  serverName?: string;
  /** Called whenever the dashboard record is (re)loaded. */
  onDashboardLoaded?: (dashboard: Dashboard | null) => void;
}

/** Toolbar + responsive grid + add-widget dialog for one dashboard. */
export function DashboardView({ dashboardId, name, type, serverId, serverName, onDashboardLoaded }: DashboardViewProps) {
  const { dashboard, widgets, isLoading, error, layoutError, clearLayoutError, addWidget, updateLayout, refresh } = useDashboard(dashboardId);
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    if (!isLoading) onDashboardLoaded?.(dashboard);
  }, [dashboard, isLoading, onDashboardLoaded]);

  const handleAdd = async (widgetType: string, targetServer: string, gridW?: number, gridH?: number) => {
    try {
      await addWidget(widgetType, targetServer, gridW, gridH);
      toast('Widget added', { variant: 'success' });
    } catch (err) {
      toast('Could not add widget', { variant: 'error', description: err instanceof Error ? err.message : String(err) });
    }
  };

  if (isLoading) return <LoadingSpinner />;
  if (error) return <ErrorState message={error} onRetry={refresh} />;

  return (
    <>
      <DashboardToolbar
        name={name}
        serverName={serverName}
        type={type}
        serverId={serverId}
        widgetCount={widgets.length}
        onAddWidget={() => setModal(true)}
        editing={editing}
        onToggleEdit={widgets.length > 0 ? () => setEditing(e => !e) : undefined}
      />
      {layoutError && (
        <div role="alert" className="mb-3 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 break-words">Layout not saved: {layoutError}</span>
          <button type="button" onClick={clearLayoutError} aria-label="Dismiss" className="rounded p-0.5 hover:bg-destructive/10">
            <X className="size-4" />
          </button>
        </div>
      )}
      {editing && (
        <p className="mb-2 text-xs text-muted-foreground">
          Drag widgets by their title bar and resize from the bottom-right corner. Changes are saved for the current screen size.
        </p>
      )}
      <DashboardGrid
        dashboardId={dashboardId}
        widgets={widgets}
        onLayoutChange={updateLayout}
        editable={editing}
        onWidgetRemoved={refresh}
        onRefresh={refresh}
        emptyAction={
          <Button onClick={() => setModal(true)}>
            <Plus />
            Add widget
          </Button>
        }
      />
      <AddWidgetModal isOpen={modal} onClose={() => setModal(false)} dashboardId={dashboardId} serverId={serverId} onAdd={handleAdd} />
    </>
  );
}
