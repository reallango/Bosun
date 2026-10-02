'use client';

import { useWidgetData } from '@/hooks/useWidgetData';
import { StatusBadge } from '@/components/shared/StatusBadge';
import { WidgetError } from '@/components/widgets/WidgetError';
import { WidgetLoading } from '@/components/widgets/WidgetLoading';

interface OllamaModel {
  name: string;
  sizeGB: number;
  parameterSize?: string;
  quantization?: string;
  family?: string;
  modifiedAt?: string | null;
}

interface OllamaLoadedModel extends OllamaModel {
  vramGB: number;
  cpuGB: number;
  expiresAt?: string | null;
}

interface OllamaData {
  status: string;
  baseUrl?: string;
  available: OllamaModel[];
  loaded: OllamaLoadedModel[];
  memory: { totalGB: number; gpuGB: number; cpuGB: number };
  cpuGpuRatio: { cpuPercent: number; gpuPercent: number };
}

export function OllamaStatusWidget({ widgetId }: { widgetId: string; serverId: string }) {
  const { data, isLoading, error, refresh } = useWidgetData(widgetId, 10);

  if (isLoading) return <WidgetLoading />;
  if (error) return <WidgetError error={error} onRetry={refresh} />;

  const d = data as OllamaData | null;
  if (!d || d.status !== 'running') {
    return (
      <div className="flex flex-col gap-2 p-2 text-sm">
        <div className="flex items-center justify-between">
          <span className="font-medium">Ollama</span>
          <StatusBadge status="offline" />
        </div>
        <div className="text-xs text-muted-foreground">
          Ollama not reachable{d?.baseUrl ? ` at ${d.baseUrl}` : ''}
        </div>
      </div>
    );
  }

  const { cpuPercent, gpuPercent } = d.cpuGpuRatio || { cpuPercent: 0, gpuPercent: 0 };
  const totalGB = d.memory?.totalGB ?? 0;

  return (
    <div className="flex flex-col gap-3 p-2 text-sm overflow-auto">
      <div className="flex items-center justify-between">
        <span className="font-medium">Ollama</span>
        <StatusBadge status="online" />
      </div>

      {/* Memory usage with CPU/GPU split */}
      <div>
        <div className="flex justify-between text-xs text-muted-foreground mb-1">
          <span>Loaded memory</span>
          <span>{totalGB} GB</span>
        </div>
        <div className="w-full h-2 rounded overflow-hidden bg-gray-200 dark:bg-gray-700 flex">
          <div className="h-full bg-green-500" style={{ width: `${gpuPercent}%` }} title={`GPU ${gpuPercent}%`} />
          <div className="h-full bg-amber-500" style={{ width: `${cpuPercent}%` }} title={`CPU ${cpuPercent}%`} />
        </div>
        <div className="flex justify-between text-[11px] mt-1 text-muted-foreground">
          <span>GPU {gpuPercent}% ({d.memory?.gpuGB ?? 0} GB)</span>
          <span>CPU {cpuPercent}% ({d.memory?.cpuGB ?? 0} GB)</span>
        </div>
      </div>

      {/* Loaded models */}
      <div>
        <div className="text-xs font-medium text-muted-foreground mb-1">
          Loaded ({d.loaded?.length ?? 0})
        </div>
        {d.loaded?.length ? (
          <div className="space-y-1">
            {d.loaded.map(m => (
              <div key={m.name} className="flex justify-between text-xs">
                <span className="truncate mr-2">{m.name}</span>
                <span className="text-muted-foreground whitespace-nowrap">
                  {m.sizeGB} GB · GPU {m.vramGB} / CPU {m.cpuGB}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-xs text-muted-foreground">No models loaded</div>
        )}
      </div>

      {/* Available models */}
      <div>
        <div className="text-xs font-medium text-muted-foreground mb-1">
          Available ({d.available?.length ?? 0})
        </div>
        <div className="space-y-1">
          {d.available?.map(m => (
            <div key={m.name} className="flex justify-between text-xs">
              <span className="truncate mr-2">{m.name}</span>
              <span className="text-muted-foreground whitespace-nowrap">
                {m.sizeGB} GB{m.parameterSize ? ` · ${m.parameterSize}` : ''}
              </span>
            </div>
          ))}
          {!d.available?.length && <div className="text-xs text-muted-foreground">No models installed</div>}
        </div>
      </div>
    </div>
  );
}
