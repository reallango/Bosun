'use client';

import { useState, useCallback } from 'react';
import { Responsive, WidthProvider } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import { Widget } from '@/types/widget';
import { WidgetFrame } from './WidgetFrame';
import { EmptyState } from '@/components/shared/EmptyState';
import { ensureArray } from '@/lib/api/ensureArray';

const GridLayout = WidthProvider(Responsive);

interface DashboardGridProps {
  dashboardId: string;
  widgets: Widget[];
  onLayoutChange?: (items: { widgetId: string; x: number; y: number; w: number; h: number }[]) => void;
  editable?: boolean;
  onWidgetRemoved?: () => void;
}

export function DashboardGrid({ dashboardId, widgets, onLayoutChange, editable = false, onWidgetRemoved }: DashboardGridProps) {
  const safeWidgets = ensureArray<Widget>(widgets);

  const [layouts, setLayouts] = useState<any[]>(() =>
    safeWidgets.map(w => ({
      i: w.id,
      x: w.grid_x ?? 0,
      y: w.grid_y ?? 0,
      w: w.grid_w ?? 4,
      h: w.grid_h ?? 3,
      minW: w.grid_min_w,
      minH: w.grid_min_h,
    }))
  );

  const handleLayoutChange = useCallback((currentLayout: readonly any[]) => {
    setLayouts([...currentLayout]);
    if (onLayoutChange) {
      onLayoutChange(currentLayout.map((l: any, idx: number) => ({
        widgetId: safeWidgets[idx]?.id || '',
        x: l.x,
        y: l.y,
        w: l.w,
        h: l.h,
      })));
    }
  }, [onLayoutChange, safeWidgets]);

  if (safeWidgets.length === 0) {
    return (
      <EmptyState
        title="No widgets yet"
        description="Add widgets to customize this dashboard"
      />
    );
  }

  return (
    <GridLayout
      className="layout"
      layouts={{ lg: layouts }}
      breakpoints={{ lg: 1200, md: 996, sm: 768, xs: 480, xxs: 0 }}
      cols={{ lg: 12, md: 10, sm: 6, xs: 4, xxs: 2 }}
      rowHeight={80}
      width={1200}
      onLayoutChange={(l) => handleLayoutChange(l as any[])}
      draggableHandle=".drag-handle"
      isDraggable={editable}
      isResizable={editable}
    >
      {safeWidgets.map(widget => (
        <div key={widget.id}>
          <WidgetFrame
            widgetId={widget.id}
            widgetType={widget.widget_type}
            title={widget.title_override || widget.widget_type}
            serverId={widget.server_id}
            editable={editable}
            onRemoved={onWidgetRemoved}
          />
        </div>
      ))}
    </GridLayout>
  );
}