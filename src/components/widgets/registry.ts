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
  custom_command: {
    type: 'custom_command',
    displayName: 'Custom Command',
    description: 'Run a command on the host as its non-admin account (PowerShell on Windows) and show its output, repeated at the interval you choose',
    configSchema: [
      { key: 'command', label: 'Command', type: 'string', placeholder: 'uptime', default: 'uptime', description: 'Runs as the non-admin shell account of the host (no sudo or Docker access) each time the widget repeats. On Windows the untouched default shows how long the machine has been up.' },
      { key: 'interval', label: 'Repeat every (seconds)', type: 'number', default: 30, description: 'How often the command runs, from 10 to 3600 seconds. The result is shared by everyone viewing the widget.' },
    ],
    icon: 'terminal',
    category: 'utility',
    defaultSize: { w: 8, h: 5 },
    minSize: { w: 6, h: 4 },
    refreshInterval: 30,
    backgroundPollable: false,
    defaultPollInterval: 60,
    defaultTTL: 1800,
    storageMode: 'latest_ttl',
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