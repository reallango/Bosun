'use client';

import { useState, useEffect } from 'react';
import { ensureArray } from '@/lib/api/ensureArray';
import { SIZE_PRESETS, SizePreset } from '@/lib/widget-sizes';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import { readJson } from '@/lib/api/readJson';
import { WidgetDefinition } from '@/types/widget';

interface Server {
  id: string;
  name: string;
  host: string;
  platform?: string;
}

interface AddWidgetModalProps {
  isOpen: boolean;
  onClose: () => void;
  dashboardId: string;
  serverId?: string;
  onAdd: (widgetType: string, serverId: string, gridW?: number, gridH?: number) => void;
}

export function AddWidgetModal({ isOpen, onClose, dashboardId, serverId, onAdd }: AddWidgetModalProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const [targetServer, setTargetServer] = useState(serverId || '');
  const [selectedSize, setSelectedSize] = useState<SizePreset>(SIZE_PRESETS[2]); // Default to Medium (S)
  const [servers, setServers] = useState<Server[]>([]);
  const [definitions, setDefinitions] = useState<WidgetDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Load the server list (only when adding from a non-server dashboard).
  useEffect(() => {
    if (isOpen && !serverId) {
      fetchWithAuth('/api/servers')
        .then(res => {
          if (!res.ok) throw new Error('Failed to fetch servers');
          return readJson<{ data?: { servers?: Server[] }; servers?: Server[] }>(res);
        })
        .then(data => setServers(ensureArray<Server>(data?.data?.servers ?? data?.servers)))
        .catch(() => setLoadError('Failed to load servers'));
    }
  }, [isOpen, serverId]);

  // Load the widget definitions supported by the selected server. Custom
  // widgets are filtered out here when the server's platform is unsupported.
  useEffect(() => {
    if (!isOpen) return;
    setLoading(true);
    setLoadError(null);
    const url = targetServer
      ? `/api/widget-definitions?serverId=${targetServer}`
      : '/api/widget-definitions';
    fetchWithAuth(url)
      .then(res => {
        if (!res.ok) throw new Error('Failed to fetch widgets');
        return readJson<{ data?: { definitions?: WidgetDefinition[] } }>(res);
      })
      .then(data => setDefinitions(ensureArray<WidgetDefinition>(data?.data?.definitions)))
      .catch(() => setLoadError('Failed to load widgets'))
      .finally(() => setLoading(false));
  }, [isOpen, targetServer]);

  useEffect(() => {
    if (!isOpen) {
      setSelected(null);
      setTargetServer(serverId || '');
      setSelectedSize(SIZE_PRESETS[2]);
      setServers([]);
      setDefinitions([]);
      setLoadError(null);
      setLoading(true);
    }
  }, [isOpen, serverId]);

  if (!isOpen) return null;

  const handleAdd = () => {
    if (selected && targetServer) {
      onAdd(selected, targetServer, selectedSize.gridW, selectedSize.gridH);
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-gray-800 rounded-lg p-6 max-w-md w-full max-h-[80vh] overflow-y-auto">
        <h3 className="text-lg font-semibold mb-4">Add Widget</h3>

        {!serverId && (
          <div className="mb-4">
            <label className="block text-sm font-medium mb-1">Server</label>
            {servers.length === 0 ? (
              <select disabled className="w-full px-3 py-2 border rounded bg-gray-50 dark:bg-gray-800 text-gray-500 dark:text-gray-400">
                <option>No servers available. Please add a server first.</option>
              </select>
            ) : (
              <select
                value={targetServer}
                onChange={e => { setTargetServer(e.target.value); setSelected(null); }}
                className="w-full px-3 py-2 border rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-white border-gray-300 dark:border-gray-600"
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

        <div className="space-y-2 mb-4 max-h-60 overflow-y-auto">
          {loading && <div className="text-sm text-gray-500 p-2">Loading widgets...</div>}
          {loadError && <div className="text-sm text-red-500 p-2">{loadError}</div>}
          {!loading && !loadError && definitions.length === 0 && (
            <div className="text-sm text-gray-500 p-2">No widgets available for this server.</div>
          )}
          {definitions.map(w => (
            <button
              key={w.type}
              onClick={() => setSelected(w.type)}
              className={`w-full text-left p-3 rounded border ${selected === w.type ? 'border-blue-500 bg-blue-50 dark:bg-blue-900' : 'hover:bg-gray-50 dark:hover:bg-gray-700'}`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{w.displayName}</span>
                {w.isCustom && (
                  <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-200">
                    Custom
                  </span>
                )}
              </div>
              <div className="text-sm text-gray-500">{w.description}</div>
            </button>
          ))}
        </div>

        <div className="mb-4">
          <label className="block text-sm font-medium mb-1">Size</label>
          <select
            value={selectedSize.id}
            onChange={e => {
              const preset = SIZE_PRESETS.find(p => p.id === e.target.value);
              if (preset) setSelectedSize(preset);
            }}
            className="w-full px-3 py-2 border rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-white border-gray-300 dark:border-gray-600"
          >
            {SIZE_PRESETS.map(preset => (
              <option key={preset.id} value={preset.id}>
                {preset.name} ({preset.description})
              </option>
            ))}
          </select>
        </div>

        <div className="flex gap-2">
          <button onClick={onClose} className="flex-1 px-4 py-2 border rounded">Cancel</button>
          <button
            onClick={handleAdd}
            disabled={!selected || !targetServer}
            className="flex-1 px-4 py-2 bg-blue-600 text-white rounded disabled:opacity-50"
          >
            Add
          </button>
        </div>
      </div>
    </div>
  );
}
