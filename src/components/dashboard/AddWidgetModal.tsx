'use client';

import { useState, useEffect } from 'react';
import {
  Activity,
  Box,
  Bot,
  Cpu,
  Gauge,
  HardDrive,
  Info,
  ListChecks,
  Network,
  PackageCheck,
  SquareTerminal,
  Terminal,
  type LucideIcon,
} from 'lucide-react';
import { ensureArray } from '@/lib/api/ensureArray';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import { SIZE_PRESETS, SizePreset } from '@/lib/widget-sizes';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

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
  onAdd: (widgetType: string, serverId: string, gridW?: number, gridH?: number) => void | Promise<void>;
}

const WIDGETS: { type: string; name: string; desc: string; icon: LucideIcon }[] = [
  { type: 'server_summary', name: 'Server Summary', desc: 'Compact server overview', icon: Activity },
  { type: 'os_info', name: 'OS Info', desc: 'OS, kernel, hostname', icon: Info },
  { type: 'cpu_memory', name: 'CPU/Memory', desc: 'Usage gauges', icon: Gauge },
  { type: 'disk_usage', name: 'Disk Usage', desc: 'Per-mount usage', icon: HardDrive },
  { type: 'network', name: 'Network', desc: 'Interfaces', icon: Network },
  { type: 'system_services', name: 'Services', desc: 'Running services', icon: ListChecks },
  { type: 'gpu_monitoring', name: 'GPU Monitoring', desc: 'NVIDIA GPU stats', icon: Cpu },
  { type: 'ollama_status', name: 'Ollama Status', desc: 'LLM runtime status', icon: Bot },
  { type: 'ssh_terminal', name: 'SSH Terminal', desc: 'Command terminal', icon: SquareTerminal },
  { type: 'os_update_check', name: 'OS Update Check', desc: 'System updates', icon: PackageCheck },
  { type: 'docker_containers', name: 'Docker Containers', desc: 'Container management', icon: Box },
  { type: 'custom_command', name: 'Custom Command', desc: 'Run custom SSH command', icon: Terminal },
];

export function AddWidgetModal({ isOpen, onClose, serverId, onAdd }: AddWidgetModalProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const [targetServer, setTargetServer] = useState(serverId || '');
  const [selectedSize, setSelectedSize] = useState<SizePreset>(SIZE_PRESETS[2]); // Default to Medium (S)
  const [servers, setServers] = useState<Server[]>([]);
  const [loadingServers, setLoadingServers] = useState(true);
  const [serversError, setServersError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    if (isOpen && !serverId) {
      setLoadingServers(true);
      setServersError(null);
      fetchWithAuth('/api/servers')
        .then(res => {
          if (!res.ok) throw new Error('Failed to fetch servers');
          return res.json();
        })
        .then(data => {
          setServers(ensureArray<Server>(data?.data?.servers ?? data?.servers));
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
      setSelectedSize(SIZE_PRESETS[2]); // Reset to Medium (S)
      setServers([]);
      setLoadingServers(true);
      setServersError(null);
      setAdding(false);
    }
  }, [isOpen, serverId]);

  const handleAdd = async () => {
    if (!selected || !targetServer) return;
    setAdding(true);
    try {
      await onAdd(selected, targetServer, selectedSize.gridW, selectedSize.gridH);
      onClose();
    } finally {
      setAdding(false);
    }
  };

  const canSubmit = !!selected && !!targetServer && (!!serverId || (servers.length > 0 && !loadingServers && !serversError));

  return (
    <Dialog open={isOpen} onOpenChange={open => !open && onClose()}>
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>Add widget</DialogTitle>
          <DialogDescription>Pick a widget type{serverId ? '' : ', a server'} and a starting size.</DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4">
          <div role="radiogroup" aria-label="Widget type" className="grid grid-cols-1 gap-2 xs:grid-cols-2 lg:grid-cols-3">
            {WIDGETS.map(w => (
              <button
                key={w.type}
                type="button"
                role="radio"
                aria-checked={selected === w.type}
                onClick={() => setSelected(w.type)}
                className={cn(
                  'flex items-start gap-3 rounded-lg border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  selected === w.type ? 'border-primary bg-primary/10' : 'hover:bg-accent'
                )}
              >
                <w.icon className={cn('mt-0.5 size-5 shrink-0', selected === w.type ? 'text-primary' : 'text-muted-foreground')} aria-hidden />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{w.name}</span>
                  <span className="block text-xs text-muted-foreground">{w.desc}</span>
                </span>
              </button>
            ))}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            {!serverId && (
              <div className="space-y-1.5">
                <Label htmlFor="add-widget-server">Server</Label>
                {loadingServers ? (
                  <select id="add-widget-server" disabled className="form-select">
                    <option>Loading servers…</option>
                  </select>
                ) : serversError ? (
                  <select id="add-widget-server" disabled className="form-select text-destructive">
                    <option>{serversError}</option>
                  </select>
                ) : servers.length === 0 ? (
                  <select id="add-widget-server" disabled className="form-select">
                    <option>No servers available. Please add a server first.</option>
                  </select>
                ) : (
                  <select id="add-widget-server" value={targetServer} onChange={e => setTargetServer(e.target.value)} className="form-select">
                    <option value="">-- Select a server --</option>
                    {servers.map(s => (
                      <option key={s.id} value={s.id}>
                        {s.name} ({s.host})
                      </option>
                    ))}
                  </select>
                )}
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="add-widget-size">Size</Label>
              <select
                id="add-widget-size"
                value={selectedSize.id}
                onChange={e => {
                  const preset = SIZE_PRESETS.find(p => p.id === e.target.value);
                  if (preset) setSelectedSize(preset);
                }}
                className="form-select"
              >
                {SIZE_PRESETS.map(preset => (
                  <option key={preset.id} value={preset.id}>
                    {preset.name} ({preset.description})
                  </option>
                ))}
              </select>
            </div>
          </div>
        </DialogBody>

        <DialogFooter>
          <Button variant="outline" size="lg" onClick={onClose}>
            Cancel
          </Button>
          <Button size="lg" onClick={handleAdd} disabled={!canSubmit || adding}>
            {adding ? 'Adding…' : 'Add widget'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
