import { ComponentType } from 'react';

export interface CustomWidgetComponentProps {
  widgetId: string;
  serverId: string;
  serverName?: string;
  config?: Record<string, unknown>;
}

/**
 * Maps a custom widget `type` (the `custom_widgets.type` column) to the React
 * component that renders it.
 *
 * Package widgets are drawn from their own declarative spec (DeclarativeWidget); nothing is registered here for them.
 */
export const customWidgetComponents: Record<string, ComponentType<CustomWidgetComponentProps>> = {
};
