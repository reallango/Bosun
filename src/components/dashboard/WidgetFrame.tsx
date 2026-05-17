'use client';

import { useState } from 'react';
import { OSInfoWidget } from '@/components/widgets/os-info';
import { CPUMemoryWidget } from '@/components/widgets/cpu-memory';
import { DiskUsageWidget } from '@/components/widgets/disk-usage';
import { NetworkWidget } from '@/components/widgets/network';
import { SystemServicesWidget } from '@/components/widgets/system-services';

interface WidgetFrameProps {
  widgetId: string;
  widgetType: string;
  title: string;
  serverId: string;
  editable?: boolean;
}

function WidgetContent({ widgetId, widgetType, serverId }: { widgetId: string; widgetType: string; serverId: string }) {
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
    default:
      return <div className="text-gray-500 text-sm">Unknown widget: {widgetType}</div>;
  }
}

export function WidgetFrame({ widgetId, widgetType, title, serverId, editable = false }: WidgetFrameProps) {
  const [menuOpen, setMenuOpen] = useState(false);

  const handleRemove = async () => {
    if (!confirm('Remove this widget?')) return;
    await fetch(`/api/widgets/${widgetId}`, { method: 'DELETE' });
    window.location.reload();
  };

  const handleRefresh = async () => {
    await fetch(`/api/widgets/${widgetId}/data?force=true`);
  };

  return (
    <div className="h-full bg-white dark:bg-gray-800 rounded-lg shadow-md border border-gray-200 dark:border-gray-700 flex flex-col">
      <div className={`flex items-center justify-between px-3 py-2 border-b border-gray-200 dark:border-gray-700 ${editable ? 'cursor-move drag-handle' : ''}`}>
        <span className="font-medium text-sm truncate">{title}</span>
        <div className="flex items-center gap-1">
          <span className="text-xs text-gray-500 mr-2">{serverId}</span>
          <button onClick={() => setMenuOpen(!menuOpen)} className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700">
            <span className="text-lg">⋮</span>
          </button>
        </div>
        {menuOpen && (
          <div className="absolute right-0 top-8 bg-white dark:bg-gray-800 border rounded shadow-lg z-10">
            <button onClick={handleRefresh} className="block w-full px-4 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700">
              Refresh
            </button>
            <button onClick={handleRemove} className="block w-full px-4 py-2 text-left text-sm text-red-600 hover:bg-gray-100 dark:hover:bg-gray-700">
              Remove
            </button>
          </div>
        )}
      </div>
      <div className="flex-1 p-3 overflow-auto">
        <WidgetContent widgetId={widgetId} widgetType={widgetType} serverId={serverId} />
      </div>
    </div>
  );
}