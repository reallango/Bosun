'use client';

import { useState } from 'react';

interface AddWidgetModalProps {
  isOpen: boolean;
  onClose: () => void;
  dashboardId: string;
  serverId?: string;
  onAdd: (widgetType: string, serverId: string) => void;
}

export function AddWidgetModal({ isOpen, onClose, dashboardId, serverId, onAdd }: AddWidgetModalProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const [targetServer, setTargetServer] = useState(serverId || '');

  if (!isOpen) return null;

  const widgets = [
    { type: 'server_summary', name: 'Server Summary', desc: 'Compact server overview' },
    { type: 'os_info', name: 'OS Info', desc: 'OS, kernel, hostname' },
    { type: 'cpu_memory', name: 'CPU/Memory', desc: 'Usage gauges' },
    { type: 'disk_usage', name: 'Disk Usage', desc: 'Per-mount usage' },
    { type: 'network', name: 'Network', desc: 'Interfaces' },
    { type: 'system_services', name: 'Services', desc: 'Running services' },
  ];

  const handleAdd = () => {
    if (selected && targetServer) {
      onAdd(selected, targetServer);
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-gray-800 rounded-lg p-6 max-w-md w-full">
        <h3 className="text-lg font-semibold mb-4">Add Widget</h3>
        
        <div className="space-y-2 mb-4">
          {widgets.map(w => (
            <button
              key={w.type}
              onClick={() => setSelected(w.type)}
              className={`w-full text-left p-3 rounded border ${selected === w.type ? 'border-blue-500 bg-blue-50 dark:bg-blue-900' : 'hover:bg-gray-50 dark:hover:bg-gray-700'}`}
            >
              <div className="font-medium">{w.name}</div>
              <div className="text-sm text-gray-500">{w.desc}</div>
            </button>
          ))}
        </div>

        {!serverId && (
          <div className="mb-4">
            <label className="block text-sm font-medium mb-1">Server</label>
            <input
              type="text"
              value={targetServer}
              onChange={e => setTargetServer(e.target.value)}
              placeholder="server-id"
              className="w-full px-3 py-2 border rounded"
            />
          </div>
        )}

        <div className="flex gap-2">
          <button onClick={onClose} className="flex-1 px-4 py-2 border rounded">Cancel</button>
          <button onClick={handleAdd} disabled={!selected || !targetServer} className="flex-1 px-4 py-2 bg-blue-600 text-white rounded disabled:opacity-50">Add</button>
        </div>
      </div>
    </div>
  );
}