'use client';

import { Dialog } from 'radix-ui';
import { X } from 'lucide-react';
import { fillTemplate } from '@/lib/widgets/runtime/spec';
import type { ScreenSpec } from '@/lib/widgets/runtime/spec-screens';
import type { ViewContext } from '@/lib/widgets/runtime/layout';
import { IconBtn, type Row } from './parts';
import type { LayoutUi } from './LayoutView';
import { ScreenView } from './ScreenView';
import { WIDGET_SIZE_DEFAULT, WidgetSizeContext } from '@/components/dashboard/widget-size';
import { DIALOG_CONTENT, DIALOG_HEADER, DIALOG_OVERLAY, DIALOG_TITLE, DIALOG_WIDTH } from './styles';

/** A `dialog` screen of a package widget as a pop-up: opened for a row (its `context`) or from a menu entry. */
export function ScreenDialog({ id, row, screen, ctx, serverId, widgetType, ui, reloadToken, onClose, onDone }: {
  id: string | null;
  row: Row | null;
  screen: ScreenSpec | undefined;
  ctx: ViewContext;
  serverId: string;
  widgetType: string;
  ui: LayoutUi;
  reloadToken: number;
  onClose: () => void;
  /** An editor in the dialog was submitted successfully. */
  onDone: () => void;
}) {
  const screenCtx: ViewContext = { ...ctx, context: row ?? undefined, screenId: id ?? undefined };
  return (
    <Dialog.Root open={!!screen && !!id} onOpenChange={o => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className={DIALOG_OVERLAY} />
        <Dialog.Content
          className={`${DIALOG_CONTENT} ${DIALOG_WIDTH[screen?.size ?? 'lg']}`}
          aria-describedby={undefined}
        >
          <div className={DIALOG_HEADER}>
            <Dialog.Title className={DIALOG_TITLE}>{screen ? fillTemplate(screen.title, screenCtx) : ''}</Dialog.Title>
            <Dialog.Close asChild><IconBtn label="Close"><X /></IconBtn></Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-auto pr-1">
            {/* A dialog has the room of the largest size, whatever the size of the widget that opened it. */}
            <WidgetSizeContext.Provider value={WIDGET_SIZE_DEFAULT}>
              {screen && id && (
                <ScreenView key={id + JSON.stringify(row ?? {})} screen={screen} context={screenCtx} serverId={serverId} widgetType={widgetType}
                  ui={ui} reloadToken={reloadToken} onDone={() => { if (!screen.keepOpenAfterSubmit) onClose(); onDone(); }} />
              )}
            </WidgetSizeContext.Provider>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
