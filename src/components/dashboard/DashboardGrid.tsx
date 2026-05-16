'use client';

import { useState, useCallback } from 'react';
import GridLayout from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import { Widget } from '@/types/widget';
import { WidgetFrame } from './WidgetFrame';
import { EmptyState } from '@/components/shared/EmptyState';

interface DashboardGridProps {
  dashboardId: string;
  widgets: Widget[];
  onLayoutChange?: (items: { widgetId: string; x: number; y: number; w: number; h: number }[]) => void;
  editable?: boolean;
}

export function DashboardGrid({ dashboardId, widgets, onLayoutChange, editable = false }: DashboardGridProps) {
  const [layouts, setLayouts] = useState<any[]>(() =>
    widgets.map(w => ({
      i: w.id,
      x: w.grid_x,
      y: w.grid_y,
      w: w.grid_w,
      h: w.grid_h,
      minW: w.grid_min_w,
      minH: w.grid_min_h,
    }))
  );

  const handleLayoutChange = useCallback((currentLayout: any[]) => {
    setLayouts(currentLayout);
    if (onLayoutChange) {
      onLayoutChange(currentLayout.map((l: any, idx: number) => ({
        widgetId: widgets[idx]?.id || '',
        x: l.x,
        y: l.y,
        w: l.w,
        h: l.h,
      })));
    }
  }, [onLayoutChange, widgets]);

  if (widgets.length === 0) {
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
      layout={layouts}
      cols={12}
      rowHeight={80}
      width={1200}
      onLayoutChange={handleLayoutChange}
      draggableHandle=".drag-handle"
      isDraggable={editable}
      isResizable={editable}
    >
      {widgets.map(widget => (
        <div key={widget.id}>
          <WidgetFrame
            widgetId={widget.id}
            widgetType={widget.widget_type}
            title={widget.title_override || widget.widget_type}
            serverId={widget.server_id}
            editable={editable}
          />
        </div>
      ))}
    </GridLayout>
  );
}