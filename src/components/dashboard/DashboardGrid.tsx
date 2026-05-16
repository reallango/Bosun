'use client';

import { useState, useCallback } from 'react';
import { Responsive, WidthProvider, Layout } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import { Widget } from '@/types/widget';
import { WidgetFrame } from './WidgetFrame';
import { EmptyState } from '@/components/shared/EmptyState';

const ResponsiveGridLayout = WidthProvider(Responsive);

interface DashboardGridProps {
  dashboardId: string;
  widgets: Widget[];
  onLayoutChange?: (layout: Layout[]) => void;
  editable?: boolean;
}

export function DashboardGrid({ dashboardId, widgets, onLayoutChange, editable = false }: DashboardGridProps) {
  const [layouts, setLayouts] = useState<{ lg: Layout[] }>(() => ({
    lg: widgets.map(w => ({
      i: w.id,
      x: w.grid_x,
      y: w.grid_y,
      w: w.grid_w,
      h: w.grid_h,
      minW: w.grid_min_w,
      minH: w.grid_min_h,
    })),
  }));

  const handleLayoutChange = useCallback((currentLayout: Layout[]) => {
    setLayouts({ lg: currentLayout });
    if (onLayoutChange) {
      onLayoutChange(currentLayout);
    }
  }, [onLayoutChange]);

  if (widgets.length === 0) {
    return (
      <EmptyState
        title="No widgets yet"
        description="Add widgets to customize this dashboard"
      />
    );
  }

  return (
    <ResponsiveGridLayout
      className="layout"
      layouts={layouts}
      breakpoints={{ lg: 1200, md: 996, sm: 768, xs: 480, xxs: 0 }}
      cols={{ lg: 12, md: 8, sm: 4, xs: 2, xxs: 1 }}
      rowHeight={80}
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
    </ResponsiveGridLayout>
  );
}