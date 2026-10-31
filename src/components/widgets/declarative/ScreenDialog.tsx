'use client';

import { Dialog } from 'radix-ui';
import { X } from 'lucide-react';
import { fillTemplate } from '@/lib/widgets/runtime/spec';
import type { ScreenSpec } from '@/lib/widgets/runtime/spec-screens';
import type { ViewContext } from '@/lib/widgets/runtime/layout';
import { IconBtn, type Row } from './parts';
import type { LayoutUi } from './LayoutView';
import { ScreenView } from './ScreenView';

const DIALOG_WIDTH: Record<string, string> = { md: 'sm:max-w-lg', lg: 'sm:max-w-3xl', xl: 'sm:max-w-5xl' };

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
  const screenCtx: ViewContext = { ...ctx, context: row ?? undefined };
  return (
    <Dialog.Root open={!!screen && !!id} onOpenChange={o => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content
          className={`fixed inset-x-2 top-4 z-50 mx-auto flex max-h-[92vh] flex-col rounded-xl border border-gray-200 bg-white p-4 shadow-xl dark:border-gray-700 dark:bg-gray-900 ${DIALOG_WIDTH[screen?.size ?? 'lg']}`}
          aria-describedby={undefined}
        >
          <div className="mb-3 flex items-start justify-between gap-2">
            <Dialog.Title className="min-w-0 truncate text-base font-semibold">{screen ? fillTemplate(screen.title, screenCtx) : ''}</Dialog.Title>
            <Dialog.Close asChild><IconBtn label="Close"><X /></IconBtn></Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-auto pr-1">
            {screen && id && (
              <ScreenView key={id + JSON.stringify(row ?? {})} screen={screen} context={screenCtx} serverId={serverId} widgetType={widgetType}
                ui={ui} reloadToken={reloadToken} onDone={() => { if (!screen.keepOpenAfterSubmit) onClose(); onDone(); }} />
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
