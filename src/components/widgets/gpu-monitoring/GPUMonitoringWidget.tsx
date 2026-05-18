'use client';

import { useWidgetData } from '@/hooks/useWidgetData';
import { StatusBadge } from '@/components/shared/StatusBadge';

interface GPUInfo {
  name: string;
  vram_total_mb: number;
  vram_used_mb: number;
  utilization_percent: number;
  temperature_c: number;
  power_watts: number;
}

export function GPUMonitoringWidget({ widgetId, serverId }: { widgetId: string; serverId: string }) {
  const { data, isLoading, error } = useWidgetData(widgetId, 10);

  if (isLoading) {
    return <div className="flex items-center justify-center h-full">Loading GPU info...</div>;
  }

  if (error) {
    return <div className="text-red-500 text-sm p-2">Error: {error}</div>;
  }

  const gpuData = data as GPUInfo | null;

  if (!gpuData) {
    return <div className="text-gray-500 text-sm p-2">No GPU detected</div>;
  }

  const vramPercent = gpuData.vram_total_mb > 0 
    ? Math.round((gpuData.vram_used_mb / gpuData.vram_total_mb) * 100) 
    : 0;

  return (
    <div className="flex flex-col gap-2 p-2 text-sm">
      <div className="flex items-center justify-between">
        <span className="font-medium">{gpuData.name}</span>
        <StatusBadge status={gpuData.utilization_percent > 80 ? 'running' : 'online'} />
      </div>
      
      <div className="grid grid-cols-2 gap-2">
        <div>
          <div className="text-xs text-gray-500">VRAM</div>
          <div className="text-sm">{gpuData.vram_used_mb} / {gpuData.vram_total_mb} MB</div>
          <div className="w-full bg-gray-200 dark:bg-gray-700 rounded h-1.5 mt-1">
            <div 
              className="bg-blue-500 h-1.5 rounded" 
              style={{ width: `${vramPercent}%` }}
            />
          </div>
        </div>
        
        <div>
          <div className="text-xs text-gray-500">GPU</div>
          <div className="text-sm">{gpuData.utilization_percent}%</div>
          <div className="w-full bg-gray-200 dark:bg-gray-700 rounded h-1.5 mt-1">
            <div 
              className="bg-green-500 h-1.5 rounded" 
              style={{ width: `${gpuData.utilization_percent}%` }}
            />
          </div>
        </div>
      </div>

      <div className="flex gap-4 mt-1 text-xs text-gray-500">
        <span>Temp: {gpuData.temperature_c}°C</span>
        <span>Power: {gpuData.power_watts}W</span>
      </div>
    </div>
  );
}