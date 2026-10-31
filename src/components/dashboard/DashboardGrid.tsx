'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Responsive, type Layout, type Layouts } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import { LayoutGrid } from 'lucide-react';
import { Widget } from '@/types/widget';
import { GridBreakpoint, LayoutItem } from '@/types/dashboard';
import {
  GRID_BREAKPOINTS,
  GRID_COLS,
  GRID_MARGIN,
  GRID_ROW_HEIGHT,
  STACKED_BREAKPOINTS,
  buildResponsiveLayouts,
} from '@/lib/widget-sizes';
import { WidgetFrame } from './WidgetFrame';
import { getWidgetDefinition } from '@/components/widgets/registry';
import { EmptyState } from '@/components/shared/EmptyState';
import { useWidgetNames } from '@/hooks/useWidgetNames';
import { ensureArray } from '@/lib/api/ensureArray';

// The container is measured with a ResizeObserver (not WidthProvider, which only
// listens to window resizes and misses sidebar collapse); never a fixed width.

interface DashboardGridProps {
  dashboardId: string;
  widgets: Widget[];
  /** Called only after the user drags/resizes, with the layout of the breakpoint that was edited. */
  onLayoutChange?: (breakpoint: GridBreakpoint, items: LayoutItem[]) => void;
  /** Edit mode: enables drag & resize. */
  editable?: boolean;
  onWidgetRemoved?: () => void;
  onRefresh?: () => void;
  emptyAction?: React.ReactNode;
}

const BREAKPOINTS_DESC = (Object.entries(GRID_BREAKPOINTS) as [GridBreakpoint, number][]).sort((a, b) => b[1] - a[1]);

function breakpointForWidth(width: number): GridBreakpoint {
  return BREAKPOINTS_DESC.find(([, min]) => width >= min)?.[0] ?? 'xxs';
}

function useContainerWidth(enabled: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el) return;
    const measure = (w: number) => setWidth(prev => (prev === w ? prev : w));
    measure(Math.floor(el.getBoundingClientRect().width));
    if (typeof ResizeObserver === 'undefined') {
      const onResize = () => measure(Math.floor(el.getBoundingClientRect().width));
      window.addEventListener('resize', onResize);
      return () => window.removeEventListener('resize', onResize);
    }
    const ro = new ResizeObserver(entries => {
      const entry = entries[0];
      if (entry) measure(Math.floor(entry.contentRect.width));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [enabled]);
  return { ref, width };
}

function useCoarsePointer() {
  const [coarse, setCoarse] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(pointer: coarse)');
    const update = () => setCoarse(mq.matches);
    update();
    mq.addEventListener?.('change', update);
    return () => mq.removeEventListener?.('change', update);
  }, []);
  return coarse;
}

export function DashboardGrid({
  dashboardId,
  widgets,
  onLayoutChange,
  editable = false,
  onWidgetRemoved,
  onRefresh,
  emptyAction,
}: DashboardGridProps) {
  const safeWidgets = useMemo(() => ensureArray<Widget>(widgets), [widgets]);
  const names = useWidgetNames();

  // Layouts for every breakpoint: saved per-breakpoint rects, otherwise derived from lg.
  const derived = useMemo(() => buildResponsiveLayouts(safeWidgets), [safeWidgets]);
  const [layouts, setLayouts] = useState<Layouts>(derived);
  const layoutsRef = useRef(layouts);
  layoutsRef.current = layouts;
  useEffect(() => {
    setLayouts(derived);
  }, [derived]);

  const { ref: containerRef, width } = useContainerWidth(safeWidgets.length > 0);
  const breakpoint = breakpointForWidth(width);
  const breakpointRef = useRef(breakpoint);
  breakpointRef.current = breakpoint;
  const coarse = useCoarsePointer();

  const stacked = STACKED_BREAKPOINTS.includes(breakpoint);
  // No drag/resize on phones with touch: it fights with page scrolling.
  const interactive = editable && !(coarse && stacked);

  // Keeps RGL controlled (so it does not snap back) but never persists:
  // this also fires on mount and on breakpoint switches.
  const handleLayoutChange = useCallback((_current: Layout[], all: Layouts) => {
    setLayouts(all);
  }, []);

  // Persist only real user edits, matched to widgets by item id (`i`).
  const persist = useCallback(
    (layout: Layout[]) => {
      if (!onLayoutChange) return;
      // A click on the handle without movement also ends a "drag": skip no-op saves.
      const before = layoutsRef.current[breakpointRef.current] ?? [];
      const key = (l: { i: string; x: number; y: number; w: number; h: number }) => `${l.i}:${l.x},${l.y},${l.w},${l.h}`;
      const prev = new Set(before.map(key));
      if (before.length === layout.length && layout.every(l => prev.has(key(l)))) return;
      const ids = new Set(safeWidgets.map(w => w.id));
      const items: LayoutItem[] = layout
        .filter(l => ids.has(l.i))
        .map(l => ({ widgetId: l.i, x: l.x, y: l.y, w: l.w, h: l.h }));
      onLayoutChange(breakpointRef.current, items);
    },
    [onLayoutChange, safeWidgets]
  );

  if (safeWidgets.length === 0) {
    return (
      <EmptyState
        icon={<LayoutGrid className="size-10" aria-hidden />}
        title="No widgets yet"
        description="Add widgets to customize this dashboard"
        action={emptyAction}
      />
    );
  }

  return (
    <div ref={containerRef} className="-mx-1 min-w-0" data-dashboard-id={dashboardId} data-breakpoint={breakpoint}>
      {width > 0 && (
      <Responsive
        width={width}
        className="layout"
        layouts={layouts}
        breakpoints={GRID_BREAKPOINTS}
        cols={GRID_COLS}
        rowHeight={GRID_ROW_HEIGHT[breakpoint]}
        margin={GRID_MARGIN}
        containerPadding={[4, 4]}
        compactType="vertical"
        onLayoutChange={handleLayoutChange}
        onDragStop={layout => persist(layout)}
        onResizeStop={layout => persist(layout)}
        draggableHandle=".drag-handle"
        draggableCancel=".no-drag"
        isDraggable={interactive}
        isResizable={interactive}
        resizeHandles={['se']}
      >
        {safeWidgets.map(widget => (
          <div key={widget.id} className="min-h-0 min-w-0">
            <WidgetFrame
              widgetId={widget.id}
              widgetType={widget.widget_type}
              title={widget.title_override || getWidgetDefinition(widget.widget_type)?.displayName || names[widget.widget_type] || widget.widget_type}
              serverId={widget.server_id}
              serverName={widget.server_name}
              editable={interactive}
              onRemoved={onWidgetRemoved}
              onRefresh={onRefresh}
            />
          </div>
        ))}
      </Responsive>
      )}
    </div>
  );
}
