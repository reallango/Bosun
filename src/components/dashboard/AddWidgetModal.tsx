'use client';

import { useState, useEffect } from 'react';
import { ensureArray } from '@/lib/api/ensureArray';

interface Server {
  id: string;
  name: string;
  host: string;
}

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
  const [servers, setServers] = useState<Server[]>([]);
  const [loadingServers, setLoadingServers] = useState(true);
  const [serversError, setServersError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen && !serverId) {
      setLoadingServers(true);
      setServersError(null);
      fetch('/api/servers')
        .then(res => {
          if (!res.ok) throw new Error('Failed to fetch servers');
          return res.json();
        })
        .then(data => {
          const servers = ensureArray<Server>(data?.data?.servers ?? data?.servers);
          setServers(servers);
          setLoadingServers(false);
        })
        .catch(err => {
          console.error('Failed to load servers:', err);
          setServersError('Failed to load servers');
          setLoadingServers(false);
        });
    }
  }, [isOpen, serverId]);

  useEffect(() => {
    if (!isOpen) {
      setSelected(null);
      setTargetServer(serverId || '');
      setServers([]);
      setLoadingServers(true);
      setServersError(null);
    }
  }, [isOpen, serverId]);

  if (!isOpen) return null;

  const widgets = [
    { type: 'server_summary', name: 'Server Summary', desc: 'Compact server overview' },
    { type: 'os_info', name: 'OS Info', desc: 'OS, kernel, hostname' },
    { type: 'cpu_memory', name: 'CPU/Memory', desc: 'Usage gauges' },
    { type: 'disk_usage', name: 'Disk Usage', desc: 'Per-mount usage' },
    { type: 'network', name: 'Network', desc: 'Interfaces' },
    { type: 'system_services', name: 'Services', desc: 'Running services' },
    { type: 'gpu_monitoring', name: 'GPU Monitoring', desc: 'NVIDIA GPU stats' },
    { type: 'ollama_status', name: 'Ollama Status', desc: 'LLM runtime status' },
    { type: 'ssh_terminal', name: 'SSH Terminal', desc: 'Command terminal' },
    { type: 'docker_containers', name: 'Docker Containers', desc: 'Container management' },
    { type: 'custom_command', name: 'Custom Command', desc: 'Run custom SSH command' },
    { type: 'portainer_link', name: 'Portainer Link', desc: 'External Portainer UI' },
  ];

  const handleAdd = () => {
    if (selected && targetServer) {
      onAdd(selected, targetServer);
      onClose();
    }
  };

  const canSubmit = selected && targetServer && servers.length > 0 && !loadingServers && !serversError;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-gray-800 rounded-lg p-6 max-w-md w-full max-h-[80vh] overflow-y-auto">
        <h3 className="text-lg font-semibold mb-4">Add Widget</h3>
        
        <div className="space-y-2 mb-4 max-h-60 overflow-y-auto">
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
            {loadingServers ? (
              <select disabled className="w-full px-3 py-2 border rounded bg-gray-50">
                <option>Loading servers...</option>
              </select>
            ) : serversError ? (
              <select disabled className="w-full px-3 py-2 border rounded bg-red-50">
                <option>{serversError}</option>
              </select>
            ) : servers.length === 0 ? (
              <select disabled className="w-full px-3 py-2 border rounded bg-gray-50">
                <option>No servers available. Please add a server first.</option>
              </select>
            ) : (
              <select
                value={targetServer}
                onChange={e => setTargetServer(e.target.value)}
                className="w-full px-3 py-2 border rounded max-h-24 overflow-y-auto"
              >
                <option value="">-- Select a Server --</option>
                {servers.map(s => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.host})
                  </option>
                ))}
              </select>
            )}
          </div>
        )}

        <div className="flex gap-2">
          <button onClick={onClose} className="flex-1 px-4 py-2 border rounded">Cancel</button>
          <button 
            onClick={handleAdd} 
            disabled={!selected || !targetServer || (servers.length === 0 && !serverId)} 
            className="flex-1 px-4 py-2 bg-blue-600 text-white rounded disabled:opacity-50"
          >
            Add
          </button>
        </div>
      </div>
    </div>
  );
}