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
  os_info: {
    type: 'os_info',
    displayName: 'OS Info',
    description: 'Operating system, kernel, hostname, uptime',
    icon: 'monitor',
    category: 'system',
    defaultSize: { w: 4, h: 2 },
    minSize: { w: 2, h: 2 },
    refreshInterval: 60,
  },
  cpu_memory: {
    type: 'cpu_memory',
    displayName: 'CPU/Memory',
    description: 'CPU and memory usage gauges with load averages',
    icon: 'cpu',
    category: 'system',
    defaultSize: { w: 4, h: 3 },
    minSize: { w: 2, h: 2 },
    refreshInterval: 5,
  },
  disk_usage: {
    type: 'disk_usage',
    displayName: 'Disk Usage',
    description: 'Per-mount disk usage with usage bars',
    icon: 'hard-drive',
    category: 'system',
    defaultSize: { w: 4, h: 3 },
    minSize: { w: 2, h: 2 },
    refreshInterval: 30,
  },
  network: {
    type: 'network',
    displayName: 'Network',
    description: 'Network interfaces with IP addresses',
    icon: 'network',
    category: 'network',
    defaultSize: { w: 4, h: 3 },
    minSize: { w: 2, h: 2 },
    refreshInterval: 30,
  },
  system_services: {
    type: 'system_services',
    displayName: 'System Services',
    description: 'Running system services with status',
    icon: 'settings',
    category: 'system',
    defaultSize: { w: 4, h: 3 },
    minSize: { w: 3, h: 2 },
    refreshInterval: 30,
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