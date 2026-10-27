'use client';

import { useState, useEffect } from 'react';
import {
  Activity,
  Box,
  Bot,
  LineChart,
  Cpu,
  Gauge,
  HardDrive,
  Info,
  ListChecks,
  Network,
  PackageCheck,
  SquareTerminal,
  Terminal,
  Puzzle,
  type LucideIcon,
} from 'lucide-react';
import { ensureArray } from '@/lib/api/ensureArray';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import { SIZE_PRESETS, SizePreset } from '@/lib/widget-sizes';
import { cn } from '@/lib/utils';
import { readJson } from '@/lib/api/readJson';
import { WidgetDefinition } from '@/types/widget';
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

// Icons by registry icon name; unknown names fall back to a puzzle piece.
const ICONS: Record<string, LucideIcon> = {
  server: Activity, monitor: Info, cpu: Cpu, 'hard-drive': HardDrive, network: Network, settings: ListChecks,
  bot: Bot, terminal: Terminal, box: Box, 'refresh-cw': PackageCheck, 'line-chart': LineChart, gauge: Gauge,
  'square-terminal': SquareTerminal,
};

export function AddWidgetModal({ isOpen, onClose, serverId, onAdd }: AddWidgetModalProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const [targetServer, setTargetServer] = useState(serverId || '');
  // null = the widget definition's default size.
  const [selectedSize, setSelectedSize] = useState<SizePreset | null>(null);
  const [servers, setServers] = useState<Server[]>([]);
  const [loadingServers, setLoadingServers] = useState(true);
  const [serversError, setServersError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [definitions, setDefinitions] = useState<WidgetDefinition[]>([]);
  const [defsLoading, setDefsLoading] = useState(true);
  const [defsError, setDefsError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen && !serverId) {
      setLoadingServers(true);
      setServersError(null);
      fetchWithAuth('/api/servers')
        .then(res => {
          if (!res.ok) throw new Error('Failed to fetch servers');
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return readJson<any>(res);
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

  // Widget types for the selected server: built-ins plus enabled custom
  // types, filtered to what that server's platform supports.
  useEffect(() => {
    if (!isOpen) return;
    let ignore = false;
    setDefsLoading(true);
    setDefsError(null);
    fetchWithAuth(targetServer ? `/api/widget-definitions?serverId=${encodeURIComponent(targetServer)}` : '/api/widget-definitions')
      .then(res => readJson<{ data?: { definitions?: WidgetDefinition[] }; error?: { message?: string } }>(res))
      .then(json => {
        if (ignore) return;
        if (json.error) throw new Error(json.error.message);
        const defs = ensureArray<WidgetDefinition>(json.data?.definitions);
        setDefinitions(defs);
        setSelected(sel => (sel && defs.some(d => d.type === sel) ? sel : null));
      })
      .catch(err => { if (!ignore) setDefsError(err instanceof Error ? err.message : 'Failed to load widgets'); })
      .finally(() => { if (!ignore) setDefsLoading(false); });
    return () => { ignore = true; };
  }, [isOpen, targetServer]);

  useEffect(() => {
    if (!isOpen) {
      setSelected(null);
      setTargetServer(serverId || '');
      setSelectedSize(null);
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
      await onAdd(selected, targetServer, selectedSize?.gridW, selectedSize?.gridH);
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
          {defsLoading && definitions.length === 0 && <p className="text-sm text-muted-foreground">Loading widgets…</p>}
          {defsError && <p role="alert" className="text-sm text-destructive">{defsError}</p>}
          {!defsLoading && !defsError && definitions.length === 0 && (
            <p className="text-sm text-muted-foreground">No widgets are available for this server.</p>
          )}
          <div role="radiogroup" aria-label="Widget type" className="grid grid-cols-1 gap-2 xs:grid-cols-2 lg:grid-cols-3">
            {definitions.map(d => ({ ...d, Icon: ICONS[d.icon] || Puzzle })).map(w => (
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
                <w.Icon className={cn('mt-0.5 size-5 shrink-0', selected === w.type ? 'text-primary' : 'text-muted-foreground')} aria-hidden />
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5 text-sm font-medium">
                    {w.displayName}
                    {w.isCustom && (
                      <span className="rounded bg-primary/10 px-1 text-[10px] font-normal uppercase tracking-wide text-primary">custom</span>
                    )}
                  </span>
                  <span className="block text-xs text-muted-foreground">{w.description}</span>
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
                value={selectedSize?.id ?? ''}
                onChange={e => {
                  const preset = SIZE_PRESETS.find(p => p.id === e.target.value);
                  setSelectedSize(preset ?? null);
                }}
                className="form-select"
              >
                <option value="">Widget default</option>
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
