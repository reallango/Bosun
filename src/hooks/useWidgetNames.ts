'use client';

import { useMemo } from 'react';
import { useWidgetDefinitions } from './useWidgetDefinitions';

/** Display names of the widget types (a package widget's name lives in its package, not in the code). */
export function useWidgetNames(): Record<string, string> {
  const definitions = useWidgetDefinitions();
  return useMemo(
    () => Object.fromEntries(Object.values(definitions).map(d => [d.type, d.displayName])),
    [definitions]
  );
}
