/**
 * Maps poller snapshots (host_snapshots sections) to the JSON each widget
 * renders. Widgets never trigger SSH for monitoring data; they read what the
 * poller last stored.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Sections = Record<string, { data: any; collectedAt: number }>;

/** Snapshot sections each widget type needs. */
export const WIDGET_SECTIONS: Record<string, string[]> = {
  server_summary: ['cpu_memory', 'disks', 'gpus', 'system', 'net_rates'],
  os_info: ['system', 'cpu_memory'],
  cpu_memory: ['cpu_memory'],
  disk_usage: ['disks'],
  network: ['network', 'net_rates'],
  system_services: ['services'],
  gpu_monitoring: ['gpus'],
  ollama_status: ['ollama'],
  docker_containers: ['docker'],
  os_update_check: ['updates'],
  metrics_chart: [],
};

export interface ServerRow {
  id: string;
  name: string;
  hostname: string;
  platform?: string | null;
  os_type?: string | null;
  os_version?: string | null;
  is_online?: number | boolean | null;
  last_seen?: string | null;
  last_error?: string | null;
  poll_interval_sec?: number | null;
}

function formatUptime(sec: number | null | undefined): string {
  if (!sec && sec !== 0) return '';
  return `${Math.floor(sec / 86400)}d ${Math.floor((sec % 86400) / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

/**
 * Returns `undefined` when the widget type is unknown, `null` when the data has
 * not been collected yet.
 */
export function widgetDataFromSnapshots(type: string, s: Sections, server: ServerRow, cfg: Record<string, any> = {}): any {
  const d = (name: string) => s[name]?.data;
  switch (type) {
    case 'server_summary': {
      const cm = d('cpu_memory');
      const disks = d('disks') as any[] | undefined;
      const root = disks?.find(x => x.mountPoint === '/' || /^C:/i.test(x.mountPoint));
      const gpus = d('gpus') as any[] | undefined;
      return {
        is_online: !!server.is_online,
        name: server.name,
        hostname: server.hostname,
        platform: server.platform || 'linux',
        os_type: server.os_type,
        os_version: server.os_version,
        os_pretty: d('system')?.prettyName ?? null,
        last_seen: server.last_seen ?? null,
        last_error: server.last_error ?? null,
        cpu_percent: cm?.cpu?.usagePercent ?? null,
        mem_percent: cm?.memory?.usagePercent ?? null,
        disk_percent: root?.usagePercent ?? null,
        uptime_seconds: cm?.uptimeSeconds ?? null,
        gpu_percent: gpus?.length ? Math.max(...gpus.map(g => g.utilization_percent || 0)) : null,
        net_rx_bps: d('net_rates')?.rxBps ?? null,
        net_tx_bps: d('net_rates')?.txBps ?? null,
      };
    }
    case 'os_info': {
      const sys = d('system');
      if (!sys) return null;
      const up = d('cpu_memory')?.uptimeSeconds ?? null;
      return {
        name: sys.name, version: sys.version, codename: sys.codename, prettyName: sys.prettyName,
        kernel: sys.kernel, architecture: sys.architecture, hostname: sys.hostname,
        uptime: formatUptime(up), uptimeSeconds: up,
      };
    }
    case 'cpu_memory':
      return d('cpu_memory') ?? null;
    case 'disk_usage':
      return d('disks') ?? null;
    case 'network':
      return d('network') ?? null;
    case 'system_services': {
      const list = d('services') as any[] | undefined;
      if (!list) return null;
      const filter = cfg.filter || 'running';
      return filter === 'all' ? list : list.filter(x => x.status === filter || (filter === 'running' && x.status === 'running'));
    }
    case 'gpu_monitoring':
      return d('gpus') ?? null;
    case 'ollama_status':
      return d('ollama') ?? null;
    case 'docker_containers':
      return d('docker') ?? null;
    case 'os_update_check':
      return d('updates') ?? null;
    case 'metrics_chart':
      return { serverId: server.id };
    default:
      return undefined;
  }
}

/** Oldest collected_at among the sections a widget uses (ms epoch). */
export function collectedAtFor(type: string, s: Sections): number | null {
  const times = (WIDGET_SECTIONS[type] || []).map(n => s[n]?.collectedAt).filter((t): t is number => typeof t === 'number');
  return times.length ? Math.min(...times) : null;
}
