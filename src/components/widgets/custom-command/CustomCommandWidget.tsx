'use client';

import { useState } from 'react';
import { useWidgetData } from '@/hooks/useWidgetData';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';

interface CustomCommandWidgetProps {
  widgetId: string;
  serverId: string;
}

export function CustomCommandWidget({ widgetId, serverId }: CustomCommandWidgetProps) {
  const { data, isLoading, error } = useWidgetData(widgetId, 30);
  const [running, setRunning] = useState(false);
  const [command, setCommand] = useState('');

  const execute = async () => {
    if (!command.trim() || running) return;
    setRunning(true);
    try {
      await fetchWithAuth(`/api/servers/${serverId}/exec`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command })
      });
      setCommand('');
    } catch (err) {
      console.error('Failed:', err);
    } finally {
      setRunning(false);
    }
  };

  if (isLoading) {
    return <div className="flex items-center justify-center h-full">Loading...</div>;
  }

  const output = data as { output?: string; exitCode?: number } | null;

  return (
    <div className="flex flex-col h-full p-2 gap-2">
      <div className="flex gap-1">
        <input
          type="text"
          value={command}
          onChange={e => setCommand(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && execute()}
          placeholder="Enter command..."
          className="flex-1 text-xs px-2 py-1 border rounded"
          disabled={running}
        />
        <button
          onClick={execute}
          disabled={running || !command.trim()}
          className="px-2 py-1 text-xs bg-blue-600 text-white rounded disabled:opacity-50"
        >
          {running ? '...' : 'Run'}
        </button>
      </div>
      {output?.output && (
        <pre className="flex-1 text-xs bg-black text-green-400 p-2 overflow-auto font-mono">
          {output.output}
        </pre>
      )}
    </div>
  );
}