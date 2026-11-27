'use client';

import { createContext, useContext } from 'react';

/**
 * True inside a widget on a dashboard, false in a dialog, sheet or full page. Blocks that can fill their space (stat
 * tiles and ring gauges) read it, so a widget uses its whole body while a dialog keeps its comfortable reading width.
 */
export const WidgetFillContext = createContext(false);

export const useWidgetFill = () => useContext(WidgetFillContext);
