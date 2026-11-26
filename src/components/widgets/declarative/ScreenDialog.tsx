'use client';

import { useCallback, useMemo, useState } from 'react';
import { fillTemplate } from '@/lib/widgets/runtime/spec';
import type { ScreenSpec } from '@/lib/widgets/runtime/spec-screens';
import type { ViewContext } from '@/lib/widgets/runtime/layout';
import type { Row } from './parts';
import type { LayoutUi } from './LayoutView';
import { ScreenView } from './ScreenView';
import { DialogFooterSlotContext, type DialogFooterSlot } from './dialog-footer-slot';
import { WIDGET_SIZE_DEFAULT, WidgetSizeContext } from '@/components/dashboard/widget-size';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

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
  const [footerTarget, setFooterTarget] = useState<HTMLDivElement | null>(null);
  const [footerClaims, setFooterClaims] = useState<ReadonlySet<string>>(() => new Set());

  const claim = useCallback((claimId: string) => {
    setFooterClaims(current => new Set(current).add(claimId));
    return () => {
      setFooterClaims(current => {
        if (!current.has(claimId)) return current;
        const next = new Set(current);
        next.delete(claimId);
        return next;
      });
    };
  }, []);
  const footerSlot = useMemo<DialogFooterSlot>(() => ({ target: footerTarget, claim }), [footerTarget, claim]);

  return (
    <Dialog open={!!screen && !!id} onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent size={screen?.size ?? 'lg'} aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{screen ? fillTemplate(screen.title, screenCtx) : ''}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          {/* A dialog has the room of the largest size, whatever the size of the widget that opened it. */}
          <WidgetSizeContext.Provider value={WIDGET_SIZE_DEFAULT}>
            <DialogFooterSlotContext.Provider value={footerSlot}>
              {screen && id && (
                <ScreenView key={id + JSON.stringify(row ?? {})} screen={screen} context={screenCtx} serverId={serverId} widgetType={widgetType}
                  ui={ui} reloadToken={reloadToken} onDone={() => { if (!screen.keepOpenAfterSubmit) onClose(); onDone(); }} />
              )}
            </DialogFooterSlotContext.Provider>
          </WidgetSizeContext.Provider>
        </DialogBody>
        <DialogFooter ref={setFooterTarget} className={footerClaims.size > 0 ? undefined : 'hidden'} />
      </DialogContent>
    </Dialog>
  );
}
