import { ComponentType } from 'react';
import { OllamaStatusWidget } from '@/components/widgets/ollama-status';

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
 * A custom widget's *definition* (sizing, caching, platform support, config
 * fields) is data in `custom_widgets`; its *collector* lives in
 * `lib/custom-widgets/collectors.js`; its *view* lives here. Registering a new
 * custom widget therefore means adding one collector entry and one component
 * entry, without touching the built-in widget switch.
 */
export const customWidgetComponents: Record<string, ComponentType<CustomWidgetComponentProps>> = {
  ollama_status: OllamaStatusWidget,
};
