import { WidgetDefinition } from '@/types/widget';

export const widgetRegistry: Record<string, WidgetDefinition> = {
  server_summary: {
    type: 'server_summary',
    displayName: 'Server Summary',
    description: 'Compact overview showing server name, online status, and basic vitals',
    icon: 'server',
    category: 'utility',
    defaultSize: { w: 3, h: 2 },
    minSize: { w: 2, h: 2 },
    refreshInterval: 15,
  },
};

export function getWidgetDefinition(type: string): WidgetDefinition | undefined {
  return widgetRegistry[type];
}

export function getWidgetsByCategory(category?: string): WidgetDefinition[] {
  const all = Object.values(widgetRegistry);
  if (!category) return all;
  return all.filter(w => w.category === category);
}