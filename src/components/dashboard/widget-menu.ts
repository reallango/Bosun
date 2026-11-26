/** The entries the frame itself adds to a widget's ⋮ menu. */
export type FrameMenuAction = 'refresh' | 'settings' | 'remove';

export interface FrameMenuEntry {
  id: FrameMenuAction;
  label: string;
  /** Draw the entry in the destructive style. */
  destructive: boolean;
}

export interface WidgetMenuGroup<T> {
  label: string;
  items: T[];
}

export interface WidgetMenuPlan<T> {
  /** The package's own entries, under the widget's display name; null when it has none. */
  widget: WidgetMenuGroup<T> | null;
  /** Refresh always; Settings and Remove only when the person may edit the dashboard. */
  frame: WidgetMenuGroup<FrameMenuEntry>;
}

/**
 * Two labelled groups: first what the widget's package offers, under the
 * widget's name, then the frame's own entries. Remove is always last and
 * destructive.
 */
export function buildWidgetMenu<T>(
  displayName: string,
  widgetItems: readonly T[],
  options: { canEdit: boolean },
): WidgetMenuPlan<T> {
  const frame: FrameMenuEntry[] = [{ id: 'refresh', label: 'Refresh', destructive: false }];
  if (options.canEdit) {
    frame.push(
      { id: 'settings', label: 'Settings', destructive: false },
      { id: 'remove', label: 'Remove', destructive: true },
    );
  }
  return {
    widget: widgetItems.length > 0 ? { label: displayName, items: [...widgetItems] } : null,
    frame: { label: 'Widget', items: frame },
  };
}
