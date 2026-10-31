'use client';

import { createContext, useContext } from 'react';

export type RefreshHandler = () => Promise<void>;

/** An entry a widget adds to the frame's ⋮ menu (a package's New container, Manage ...). */
export interface FrameMenuItem {
  id: string;
  label: string;
  icon?: React.ComponentType<{ className?: string }>;
  onSelect: () => void;
}

export interface WidgetFrameContextValue {
  /** Add entries to the frame's ⋮ menu; returns a function that takes them away again. */
  registerMenu: (items: FrameMenuItem[]) => () => void;
  /**
   * Register a refresh handler for the widget inside this frame. The frame's
   * "Refresh" action calls every registered handler. Returns an unregister fn.
   */
  registerRefresh: (handler: RefreshHandler) => () => void;
}

export const WidgetFrameContext = createContext<WidgetFrameContextValue | null>(null);

export function useWidgetFrame() {
  return useContext(WidgetFrameContext);
}
