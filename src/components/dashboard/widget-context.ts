'use client';

import { createContext, useContext } from 'react';

export type RefreshHandler = () => Promise<void>;

export interface WidgetFrameContextValue {
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
