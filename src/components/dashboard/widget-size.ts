'use client';

import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { sizeClassFor, type WidgetSize } from '@/lib/widgets/runtime/size';

/** How much room the widget inside a frame has (its content box), shared with every widget the same way. */
export interface WidgetSizeInfo {
  width: number;
  height: number;
  size: WidgetSize;
}

/** Outside a frame (dialogs, full pages) a widget has the room of the largest class. */
export const WIDGET_SIZE_DEFAULT: WidgetSizeInfo = { width: 0, height: 0, size: 'lg' };

export const WidgetSizeContext = createContext<WidgetSizeInfo>(WIDGET_SIZE_DEFAULT);

/** The size class (and pixels) of the widget this component is rendered in. */
export function useWidgetSize(): WidgetSizeInfo {
  return useContext(WidgetSizeContext);
}

/** Measures an element with a ResizeObserver; the state only changes when the size class or the (rounded) pixels change. */
export function useMeasuredSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [info, setInfo] = useState<WidgetSizeInfo>(WIDGET_SIZE_DEFAULT);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(entries => {
      const box = entries[0]?.contentRect;
      if (!box) return;
      // Pixels in steps of 8 so a drag-resize does not re-render the widget on every pixel; the class uses the exact width.
      const size = sizeClassFor(box.width);
      const width = Math.round(box.width / 8) * 8;
      const height = Math.round(box.height / 8) * 8;
      setInfo(prev => (prev.width === width && prev.height === height && prev.size === size ? prev : { width, height, size }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, info };
}
