'use client';

import { useEffect, useRef, useState } from 'react';
import { useWidgetData } from '@/hooks/useWidgetData';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';

export function SSHTerminalWidget({ widgetId, serverId }: { widgetId: string; serverId: string }) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const [command, setCommand] = useState('');
  const [history, setHistory] = useState<{ type: 'input' | 'output'; text: string }[]>([
    { type: 'output', text: 'Type a command and press Enter to execute.' }
  ]);
  const [running, setRunning] = useState(false);
  const [sessionId] = useState(() => Math.random().toString(36).substring(2, 9));

  const execute = async () => {
    if (!command.trim() || running) return;
    const cmd = command.trim();
    setCommand('');
    setHistory(h => [...h, { type: 'input', text: `$ ${cmd}` }]);
    setRunning(true);

    try {
      const res = await fetchWithAuth(`/api/servers/${serverId}/exec`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: cmd, sessionId })
      });
      const json = await res.json();
      if (json.error) {
        setHistory(h => [...h, { type: 'output', text: `Error: ${json.error.message}` }]);
      } else {
        setHistory(h => [...h, { type: 'output', text: json.data?.output || json.data?.error || 'Command executed' }]);
      }
    } catch (err) {
      setHistory(h => [...h, { type: 'output', text: `Error: ${err}` }]);
    } finally {
      setRunning(false);
    }
  };

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      execute();
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div 
        ref={terminalRef}
        className="flex-1 bg-black text-green-400 font-mono text-xs p-2 overflow-auto"
        style={{ minHeight: '150px' }}
      >
        {history.map((item, i) => (
          <div key={i} className="whitespace-pre-wrap">{item.text}</div>
        ))}
        {running && <div className="animate-pulse">_</div>}
      </div>
      <div className="flex border-t border-green-800">
        <span className="text-green-400 font-mono text-xs p-2">$</span>
        <input
          type="text"
          value={command}
          onChange={e => setCommand(e.target.value)}
          onKeyDown={handleKey}
          disabled={running}
          className="flex-1 bg-black text-green-400 font-mono text-xs p-2 outline-none"
          placeholder="Enter command..."
        />
      </div>
    </div>
  );
}