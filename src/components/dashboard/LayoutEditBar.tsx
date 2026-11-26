'use client';

import { useState } from 'react';
import { Monitor, RotateCcw, Smartphone, Tablet, Laptop, Copy } from 'lucide-react';
import type { GridBreakpoint, LayoutItem } from '@/types/dashboard';
import type { Widget } from '@/types/widget';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { BREAKPOINT_LABELS, GRID_BREAKPOINTS, GRID_COLS, STACKED_BREAKPOINTS, hasOwnLayout } from '@/lib/widget-sizes';

const ICON: Record<GridBreakpoint, React.ComponentType<{ className?: string }>> = {
  xxl: Monitor, xl: Monitor, lg: Laptop, md: Laptop, sm: Tablet, xs: Smartphone, xxs: Smartphone,
};

interface Props {
  breakpoint: GridBreakpoint;
  widgets: Widget[];
  currentLayout: () => LayoutItem[];
  onReset: () => void;
  onUseEverywhere: (layout: LayoutItem[]) => void;
}

/**
 * The bar above the grid in edit mode: which screen size is being arranged, whether it has its own arrangement or follows
 * the base layout, and the two layout actions (reset this size, use this arrangement on every size).
 */
export function LayoutEditBar({ breakpoint, widgets, currentLayout, onReset, onUseEverywhere }: Props) {
  const [confirm, setConfirm] = useState(false);
  const Icon = ICON[breakpoint];
  const stacked = STACKED_BREAKPOINTS.includes(breakpoint);
  const own = hasOwnLayout(widgets, breakpoint);
  const min = GRID_BREAKPOINTS[breakpoint];

  return (
    <div className="mx-1 mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
      <Icon className="size-4 shrink-0 text-primary" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="font-medium">
          Arranging for {BREAKPOINT_LABELS[breakpoint].toLowerCase()}
          <span className="ml-1.5 font-normal text-muted-foreground">
            ({min > 0 ? `${min}px and wider` : 'narrowest'}, {GRID_COLS[breakpoint]} columns)
          </span>
        </div>
        <div className="text-xs text-muted-foreground">
          {stacked
            ? 'Widgets stack in one column here. Drag to change their order; this only affects phones.'
            : own
              ? 'This size has its own arrangement. Your changes here also become the base that sizes you have not arranged follow.'
              : 'This size follows the base layout. Drag or resize to arrange it; other sizes you have not arranged will follow.'}
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        {own && (
          <Button size="sm" variant="outline" onClick={onReset} title="Drop this size's own arrangement and follow the base layout">
            <RotateCcw />
            Reset this size
          </Button>
        )}
        {!stacked && (
          <Button size="sm" variant="outline" onClick={() => setConfirm(true)} title="Use this arrangement on every screen size">
            <Copy />
            Use on all sizes
          </Button>
        )}
      </div>
      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent size="sm" role="alertdialog">
          <DialogHeader>
            <DialogTitle>Use this arrangement on every screen size?</DialogTitle>
            <DialogDescription>
              Every other screen size, phones included, drops its own arrangement and follows this one, scaled to fit.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="lg" onClick={() => setConfirm(false)}>Cancel</Button>
            <Button size="lg" onClick={() => { setConfirm(false); onUseEverywhere(currentLayout()); }}>Use on all sizes</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
