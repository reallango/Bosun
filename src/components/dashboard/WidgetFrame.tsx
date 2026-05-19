'use client';

import { useState } from 'react';
import { OSInfoWidget } from '@/components/widgets/os-info';
import { CPUMemoryWidget } from '@/components/widgets/cpu-memory';
import { DiskUsageWidget } from '@/components/widgets/disk-usage';
import { NetworkWidget } from '@/components/widgets/network';
import { SystemServicesWidget } from '@/components/widgets/system-services';
import { ServerSummaryWidget } from '@/components/widgets/server-summary';
import { GPUMonitoringWidget } from '@/components/widgets/gpu-monitoring';
import { OllamaStatusWidget } from '@/components/widgets/ollama-status';
import { SSHTerminalWidget } from '@/components/widgets/ssh-terminal';
import { DockerContainersWidget } from '@/components/widgets/docker-containers';
import { CustomCommandWidget } from '@/components/widgets/custom-command';
import { PortainerLinkWidget } from '@/components/widgets/portainer-link';
import { OSUpdateCheckWidget } from '@/components/widgets/os-update-check';
import { WidgetSettingsDialog } from '@/components/dialogs/WidgetSettingsDialog';
import { DeleteConfirmDialog } from '@/components/dialogs/DeleteConfirmDialog';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';

interface WidgetFrameProps {
  widgetId: string;
  widgetType: string;
  title: string;
  serverId: string;
  serverName?: string;
  editable?: boolean;
  onRemoved?: () => void;
}

function WidgetContent({ widgetId, widgetType, serverId, serverName }: { widgetId: string; widgetType: string; serverId: string; serverName?: string }) {
  switch (widgetType) {
    case 'os_info':
    case 'os-info':
      return <OSInfoWidget widgetId={widgetId} serverId={serverId} />;
    case 'cpu_memory':
    case 'cpu-memory':
      return <CPUMemoryWidget widgetId={widgetId} />;
    case 'disk_usage':
    case 'disk-usage':
      return <DiskUsageWidget widgetId={widgetId} />;
    case 'network':
      return <NetworkWidget widgetId={widgetId} />;
    case 'system_services':
    case 'system-services':
      return <SystemServicesWidget widgetId={widgetId} serverId={serverId} />;
    case 'server_summary':
      return <ServerSummaryWidget widgetId={widgetId} serverId={serverId} serverName={serverName} />;
    case 'gpu_monitoring':
      return <GPUMonitoringWidget widgetId={widgetId} serverId={serverId} />;
    case 'ollama_status':
      return <OllamaStatusWidget widgetId={widgetId} serverId={serverId} />;
    case 'ssh_terminal':
      return <SSHTerminalWidget widgetId={widgetId} serverId={serverId} />;
    case 'docker_containers':
      return <DockerContainersWidget widgetId={widgetId} serverId={serverId} />;
    case 'custom_command':
      return <CustomCommandWidget widgetId={widgetId} serverId={serverId} />;
    case 'portainer_link':
      return <PortainerLinkWidget widgetId={widgetId} serverId={serverId} />;
    case 'os_update_check':
      return <OSUpdateCheckWidget widgetId={widgetId} serverId={serverId} />;
    default:
      return <div className="text-gray-500 text-sm">Unknown widget: {widgetType}</div>;
  }
}

export function WidgetFrame({ widgetId, widgetType, title, serverId, serverName, editable = false, onRemoved }: WidgetFrameProps) {
  const [removing, setRemoving] = useState(false);

  const handleRemove = async () => {
    setDeleteOpen(true);
  };

  const doRemove = async () => {
    setRemoving(true);
    try {
      const res = await fetchWithAuth(`/api/widgets/${widgetId}`, { method: 'DELETE' });
      const json = await res.json();
      if (json.success && onRemoved) {
        onRemoved();
      } else if (json.error) {
        alert('Failed to remove widget: ' + json.error.message);
      }
    } catch (err) {
      alert('Failed to remove widget');
    } finally {
      setRemoving(false);
    }
  };

  const handleRefresh = async () => {
    await fetch(`/api/widgets/${widgetId}/data?force=true`);
  };

  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  return (
    <div className="h-full bg-white dark:bg-gray-800 rounded-lg shadow-md border border-gray-200 dark:border-gray-700 flex flex-col">
      <div className={`flex items-center justify-between px-3 py-2 border-b border-gray-200 dark:border-gray-700 ${editable ? 'cursor-move drag-handle' : ''}`}>
        <span className="font-medium text-sm truncate">{title}</span>
        <div className="flex items-center gap-1">
          {serverName && <span className="text-xs text-gray-500 mr-1">{serverName}</span>}
          <DropdownMenu.Root open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenu.Trigger asChild>
              <button className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700">
                <span className="text-lg">⋮</span>
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Content className="min-w-[140px] bg-white dark:bg-gray-800 border rounded shadow-lg z-10">
              <DropdownMenu.Item 
                className="px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer outline-none"
                onSelect={() => {
                  setMenuOpen(false);
                  setSettingsOpen(true);
                }}
              >
                Settings
              </DropdownMenu.Item>
              <DropdownMenu.Item 
                className="px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer outline-none"
                onSelect={() => {
                  setMenuOpen(false);
                  handleRefresh();
                }}
              >
                Refresh
              </DropdownMenu.Item>
              <DropdownMenu.Separator className="h-px bg-gray-200 dark:bg-gray-700 my-1" />
              <DropdownMenu.Item 
                className="px-4 py-2 text-sm text-red-600 hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer outline-none disabled:opacity-50"
                disabled={removing}
                onSelect={() => {
                  setMenuOpen(false);
                  handleRemove();
                }}
              >
                {removing ? 'Removing...' : 'Remove'}
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Root>
        </div>
      </div>
      <div className="flex-1 p-3 overflow-auto">
        <WidgetContent widgetId={widgetId} widgetType={widgetType} serverId={serverId} serverName={serverName} />
      </div>
      <WidgetSettingsDialog widgetId={widgetId} open={settingsOpen} onOpenChange={setSettingsOpen} />
      <DeleteConfirmDialog widgetTitle={title} open={deleteOpen} onOpenChange={setDeleteOpen} onConfirm={doRemove} loading={removing} />
    </div>
  );
}