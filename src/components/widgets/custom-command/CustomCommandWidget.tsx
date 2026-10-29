'use client';

import { useState } from 'react';
import { Play } from 'lucide-react';
import { useWidgetData } from '@/hooks/useWidgetData';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import { WidgetLoading } from '@/components/widgets/WidgetLoading';
import { WidgetError } from '@/components/widgets/WidgetError';
import { useAuth } from '@/hooks/useAuth';

interface CustomCommandWidgetProps {
  widgetId: string;
  serverId: string;
}

export function CustomCommandWidget({ widgetId, serverId }: CustomCommandWidgetProps) {
  const { data, isLoading, error, refresh } = useWidgetData(widgetId, 30);
  const [running, setRunning] = useState(false);
  const [command, setCommand] = useState('');
  const [execError, setExecError] = useState<string | null>(null);
  const { can } = useAuth();
  // Ad-hoc commands (/exec) need Full access; others see the configured command's output.
  const canExec = can('commands.run', serverId);

  const execute = async () => {
    if (!command.trim() || running) return;
    setRunning(true);
    setExecError(null);
    try {
      const res = await fetchWithAuth(`/api/servers/${serverId}/exec`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command })
      });
      if (!res.ok) {
        const json = await res.json().catch(() => null);
        throw new Error(json?.error?.message || `HTTP ${res.status}`);
      }
      setCommand('');
    } catch (err) {
      setExecError(err instanceof Error ? err.message : 'Command failed');
    } finally {
      setRunning(false);
    }
  };

  if (isLoading) return <WidgetLoading />;

  const output = data as { output?: string; exitCode?: number } | null;

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      {canExec && (
      <form
        className="flex gap-1.5"
        onSubmit={e => {
          e.preventDefault();
          execute();
        }}
      >
        <label className="sr-only" htmlFor={`cmd-${widgetId}`}>Command</label>
        <input
          id={`cmd-${widgetId}`}
          type="text"
          value={command}
          onChange={e => setCommand(e.target.value)}
          placeholder="Enter command…"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className="no-drag h-8 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 font-mono text-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
          disabled={running}
        />
        <button
          type="submit"
          disabled={running || !command.trim()}
          className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Run command"
        >
          <Play className="size-3.5" aria-hidden />
          <span className="hidden @[14rem]:inline">{running ? 'Running…' : 'Run'}</span>
        </button>
      </form>
      )}
      {execError && <div role="alert" className="text-xs text-destructive">{execError}</div>}
      {error && !output?.output && <WidgetError error={error} onRetry={refresh} />}
      {output?.output && (
        <pre className="min-h-0 flex-1 overflow-auto whitespace-pre rounded-md bg-black p-2 font-mono text-[11px] leading-snug text-green-400 @md:text-xs">
          {output.output}
        </pre>
      )}
    </div>
  );
}
