'use client';

import { useState, useCallback } from 'react';
import { Responsive, WidthProvider } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import { Widget } from '@/types/widget';
import { WidgetFrame } from './WidgetFrame';
import { EmptyState } from '@/components/shared/EmptyState';

const GridLayout = WidthProvider(Responsive);

interface DashboardGridProps {
  dashboardId: string;
  widgets: Widget[];
  onLayoutChange?: (items: { widgetId: string; x: number; y: number; w: number; h: number }[]) => void;
  editable?: boolean;
  onWidgetRemoved?: () => void;
}

export function DashboardGrid({ dashboardId, widgets, onLayoutChange, editable = false, onWidgetRemoved }: DashboardGridProps) {
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

  const handleLayoutChange = useCallback((currentLayout: readonly any[]) => {
    setLayouts([...currentLayout]);
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
      {widgets.map(widget => (
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