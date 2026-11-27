'use client';

import { createContext, useContext } from 'react';
import type { Density } from '@/lib/widgets/runtime/sizing';

/**
 * True inside a widget on a dashboard, false in a dialog, sheet or full page. Blocks that can fill their space (stat
 * tiles and ring gauges) read it, so a widget uses its whole body while a dialog keeps its comfortable reading width.
 */
export const WidgetFillContext = createContext(false);

export const useWidgetFill = () => useContext(WidgetFillContext);

/**
 * The widget's `density` (default comfortable). A filling block turns compact at a short height even when the spec
 * asks for comfortable; the density only makes that the default for every height.
 */
export const WidgetDensityContext = createContext<Density>('comfortable');

export const useWidgetDensity = () => useContext(WidgetDensityContext);
