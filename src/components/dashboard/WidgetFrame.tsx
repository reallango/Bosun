'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import dynamic from 'next/dynamic';
import { EllipsisVertical, GripVertical, RefreshCw, Settings2, Trash2 } from 'lucide-react';
import { WidgetErrorBoundary } from '@/components/widgets/WidgetErrorBoundary';
import { WidgetSettingsDialog } from '@/components/dialogs/WidgetSettingsDialog';
import { DeleteConfirmDialog } from '@/components/dialogs/DeleteConfirmDialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useToast } from '@/components/ui/toast';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import { cn } from '@/lib/utils';
import { RefreshHandler, WidgetFrameContext } from './widget-context';
import { customWidgetComponents } from '@/components/widgets/custom-registry';
import { DeclarativeWidget } from '@/components/widgets/declarative/DeclarativeWidget';
import { WidgetLoading } from '@/components/widgets/WidgetLoading';
import { useAuth } from '@/hooks/useAuth';
import { hasRole } from '@/lib/auth/levels';

// xterm and its addons are ~390 kB of JS. Loading the terminal lazily keeps
// them out of every dashboard route's first load; the chunk is fetched only
// when a terminal widget actually mounts.
const SSHTerminalWidget = dynamic(
  () => import('@/components/widgets/ssh-terminal').then(m => m.SSHTerminalWidget),
  { ssr: false, loading: () => <WidgetLoading /> },
);

interface WidgetFrameProps {
  widgetId: string;
  widgetType: string;
  title: string;
  serverId: string;
  serverName?: string;
  editable?: boolean;
  onRemoved?: () => void;
  onRefresh?: () => void;
}

function TerminalLocked() {
  return (
    <div className="flex h-full items-center justify-center p-4 text-center text-sm text-muted-foreground">
      Terminals need Full access. Ask an admin if you need a shell on this server.
    </div>
  );
}

function SSHTerminalGate({ widgetId, serverId }: { widgetId: string; serverId: string }) {
  const { user } = useAuth();
  if (!hasRole(user?.role, 'admin')) return <TerminalLocked />;
  return <SSHTerminalGate widgetId={widgetId} serverId={serverId} />;
}

function WidgetContent({ widgetId, widgetType, serverId, serverName }: { widgetId: string; widgetType: string; serverId: string; serverName?: string }) {
  switch (widgetType) {
    case 'ssh_terminal':
      return <SSHTerminalWidget widgetId={widgetId} serverId={serverId} />;
    default:
    {
      // Database-defined widget types render through the custom registry.
      const Custom = customWidgetComponents[widgetType];
      if (Custom) return <Custom widgetId={widgetId} serverId={serverId} serverName={serverName} />;
      // Package widgets render from their declarative spec; the component says so if the type has none.
      return <DeclarativeWidget widgetId={widgetId} widgetType={widgetType} serverId={serverId} />;
    }
  }
}

/** Widgets that manage their own scrolling/padding (edge-to-edge content). */
const FULL_BLEED = new Set(['ssh_terminal']);

/** Human title for a raw widget type ("cpu_memory" -> "Cpu memory") when no name is set. */
function prettyType(type: string) {
  const s = type.replace(/[_-]+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function WidgetFrame({ widgetId, widgetType, title, serverId, serverName, editable = false, onRemoved, onRefresh }: WidgetFrameProps) {
  const { toast } = useToast();
  const [removing, setRemoving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const { can } = useAuth();
  // Settings and removal edit the dashboard.
  const canEdit = can('dashboards.edit');

  // Refresh handlers registered by the widget inside (via useWidgetData).
  const handlers = useRef(new Set<RefreshHandler>());
  const frameContext = useMemo(
    () => ({
      registerRefresh: (handler: RefreshHandler) => {
        handlers.current.add(handler);
        return () => {
          handlers.current.delete(handler);
        };
      },
    }),
    []
  );

  // The grid passes the saved title (or the definition's name), so no per-widget fetch is needed.
  const displayTitle = title === widgetType ? prettyType(widgetType) : title;

  const doRemove = async () => {
    setRemoving(true);
    try {
      const res = await fetchWithAuth(`/api/widgets/${widgetId}`, { method: 'DELETE' });
      const json = await res.json().catch(() => null);
      if (res.ok && json?.success !== false && !json?.error) {
        toast(`Removed “${displayTitle}”`, { variant: 'success' });
        onRemoved?.();
      } else {
        toast('Failed to remove widget', { variant: 'error', description: json?.error?.message || `HTTP ${res.status}` });
      }
    } catch (err) {
      toast('Failed to remove widget', { variant: 'error', description: err instanceof Error ? err.message : undefined });
    } finally {
      setRemoving(false);
    }
  };

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      if (handlers.current.size > 0) {
        // Forced, authenticated fetch whose result lands in the widget's state.
        await Promise.all(Array.from(handlers.current).map(fn => fn()));
      } else {
        // Widget manages its own data: still bust the server-side cache.
        const res = await fetchWithAuth(`/api/widgets/${widgetId}/data?force=true`);
        if (!res.ok) {
          const json = await res.json().catch(() => null);
          throw new Error(json?.error?.message || `HTTP ${res.status}`);
        }
      }
    } catch (err) {
      toast('Refresh failed', { variant: 'error', description: err instanceof Error ? err.message : String(err) });
    } finally {
      setRefreshing(false);
    }
  }, [widgetId, toast]);

  return (
    <section
      className={cn(
        '@container/frame flex h-full min-h-0 flex-col overflow-hidden rounded-xl border bg-card text-card-foreground shadow-sm',
        editable && 'ring-1 ring-primary/30'
      )}
      aria-label={displayTitle}
    >
      <header
        className={cn(
          'flex h-9 shrink-0 items-center gap-1.5 border-b px-2.5',
          editable && 'drag-handle cursor-move select-none touch-none bg-muted/40'
        )}
      >
        {editable && <GripVertical className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium" title={displayTitle}>
          {displayTitle}
        </h2>
        {serverName && (
          <span
            className="hidden max-w-[40%] shrink truncate rounded-full bg-muted px-2 py-0.5 text-[11px] leading-4 text-muted-foreground @[16rem]/frame:inline-block"
            title={serverName}
          >
            {serverName}
          </span>
        )}
        {refreshing && <RefreshCw className="size-3.5 shrink-0 animate-spin text-muted-foreground" aria-label="Refreshing" />}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="no-drag -mr-1 inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`Widget actions for ${displayTitle}`}
            >
              <EllipsisVertical className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onSelect={() => handleRefresh()} disabled={refreshing}>
              <RefreshCw />
              Refresh
            </DropdownMenuItem>
            {canEdit && (
              <>
            <DropdownMenuItem onSelect={() => setSettingsOpen(true)}>
              <Settings2 />
              Settings
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" disabled={removing} onSelect={() => setDeleteOpen(true)}>
              <Trash2 />
              {removing ? 'Removing…' : 'Remove'}
            </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </header>
      <div
        className={cn(
          '@container relative min-h-0 flex-1',
          FULL_BLEED.has(widgetType) ? 'overflow-hidden' : 'overflow-auto overscroll-contain p-3'
        )}
      >
        <WidgetFrameContext.Provider value={frameContext}>
          <WidgetErrorBoundary widgetId={widgetId}>
            <WidgetContent widgetId={widgetId} widgetType={widgetType} serverId={serverId} serverName={serverName} />
          </WidgetErrorBoundary>
        </WidgetFrameContext.Provider>
      </div>
      <WidgetSettingsDialog widgetId={widgetId} open={settingsOpen} onOpenChange={setSettingsOpen} onSave={onRefresh} />
      <DeleteConfirmDialog widgetTitle={displayTitle} open={deleteOpen} onOpenChange={setDeleteOpen} onConfirm={doRemove} loading={removing} />
    </section>
  );
}
