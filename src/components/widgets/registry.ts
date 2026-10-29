import { WidgetDefinition } from '@/types/widget';

export const widgetRegistry: Record<string, WidgetDefinition> = {
  ssh_terminal: {
    type: 'ssh_terminal',
    displayName: 'SSH Terminal',
    description: 'Interactive command terminal',
    icon: 'terminal',
    category: 'utility',
    defaultSize: { w: 12, h: 8 },
    minSize: { w: 8, h: 6 },
    refreshInterval: 0,
    backgroundPollable: false,
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