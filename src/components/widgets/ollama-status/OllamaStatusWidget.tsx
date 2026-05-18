'use client';

import { useWidgetData } from '@/hooks/useWidgetData';
import { StatusBadge } from '@/components/shared/StatusBadge';

interface OllamaInfo {
  status: string;
  models: { name: string; size: number; modified_at: string }[];
  pulling?: { name: string; progress: number };
}

export function OllamaStatusWidget({ widgetId, serverId }: { widgetId: string; serverId: string }) {
  const { data, isLoading, error } = useWidgetData(widgetId, 30);

  if (isLoading) {
    return <div className="flex items-center justify-center h-full">Loading Ollama status...</div>;
  }

  if (error) {
    return <div className="text-red-500 text-sm p-2">Error: {error}</div>;
  }

  const ollamaData = data as OllamaInfo | null;

  if (!ollamaData) {
    return <div className="text-gray-500 text-sm p-2">Ollama not running</div>;
  }

  return (
    <div className="flex flex-col gap-2 p-2 text-sm">
      <div className="flex items-center justify-between">
        <span className="font-medium">Ollama</span>
        <StatusBadge status={ollamaData.status === 'running' ? 'online' : 'offline'} />
      </div>
      
      {ollamaData.pulling && (
        <div>
          <div className="text-xs text-gray-500">Pulling: {ollamaData.pulling.name}</div>
          <div className="w-full bg-gray-200 dark:bg-gray-700 rounded h-2 mt-1">
            <div 
              className="bg-blue-500 h-2 rounded transition-all" 
              style={{ width: `${ollamaData.pulling.progress}%` }}
            />
          </div>
          <div className="text-xs text-right">{ollamaData.pulling.progress}%</div>
        </div>
      )}

      <div className="text-xs text-gray-500 mt-1">
        {ollamaData.models?.length || 0} model(s) loaded
      </div>
      
      {ollamaData.models?.slice(0, 5).map((model, i) => (
        <div key={i} className="text-xs flex justify-between">
          <span className="truncate">{model.name}</span>
          <span className="text-gray-400">{Math.round(model.size / 1e9)}GB</span>
        </div>
      ))}
    </div>
  );
}