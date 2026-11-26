'use client';

import { createContext, useContext } from 'react';

export interface DialogFooterSlot {
  /** The dialog's footer element, once it is mounted. */
  target: HTMLElement | null;
  /** Claim a place in the footer; the returned function releases it. */
  claim: (id: string) => () => void;
}

/**
 * Lets a screen rendered inside a dialog move its editors' submit rows into the
 * dialog footer. Without a provider (a page, or a widget on a dashboard) the
 * same editors keep their buttons inline.
 */
export const DialogFooterSlotContext = createContext<DialogFooterSlot | null>(null);

export function useDialogFooterSlot() {
  return useContext(DialogFooterSlotContext);
}
