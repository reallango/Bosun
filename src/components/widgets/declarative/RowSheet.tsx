'use client';

import { fillTemplate } from '@/lib/widgets/runtime/spec';
import type { ScreenSpec } from '@/lib/widgets/runtime/spec-screens';
import type { ViewContext } from '@/lib/widgets/runtime/layout';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { WIDGET_SIZE_DEFAULT, WidgetSizeContext } from '@/components/dashboard/widget-size';
import type { Row } from './parts';
import type { LayoutUi } from './LayoutView';
import { ScreenView } from './ScreenView';

/**
 * A row's details: the screen a view names with `open`, shown in a side sheet (from the right on a desktop, full screen on a
 * phone) with the clicked row as its `context`, exactly as a row action that opens a screen would pass it.
 */
export function RowSheet({ id, row, screen, ctx, serverId, widgetType, ui, reloadToken, onClose, onDone }: {
  id: string | null;
  row: Row | null;
  screen: ScreenSpec | undefined;
  ctx: ViewContext;
  serverId: string;
  widgetType: string;
  ui: LayoutUi;
  reloadToken: number;
  onClose: () => void;
  /** Something in the sheet changed the host: reload the widget behind it. */
  onDone: () => void;
}) {
  const screenCtx: ViewContext = { ...ctx, context: row ?? undefined, screenId: id ?? undefined };
  return (
    <Sheet open={!!screen && !!id} onOpenChange={o => { if (!o) onClose(); }}>
      <SheetContent side="right" className="w-full max-w-none sm:max-w-md" aria-describedby={undefined}>
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="border-b border-border px-4 py-3 pr-10">
            <SheetTitle className="truncate text-base">{screen ? fillTemplate(screen.title, screenCtx) : ''}</SheetTitle>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-4">
            {/* A sheet has the room of the largest size, whatever the size of the widget that opened it. */}
            <WidgetSizeContext.Provider value={WIDGET_SIZE_DEFAULT}>
              {screen && id && (
                <ScreenView key={id + JSON.stringify(row ?? {})} screen={screen} context={screenCtx} serverId={serverId} widgetType={widgetType}
                  ui={ui} reloadToken={reloadToken} onDone={() => { if (!screen.keepOpenAfterSubmit) onClose(); onDone(); }} />
              )}
            </WidgetSizeContext.Provider>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
