'use client';

import { useState, useEffect, useCallback } from 'react';
import { ChevronDown, ChevronUp, CircleCheck, Package, RotateCcw, ShieldAlert, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import { useWidgetFrame } from '@/components/dashboard/widget-context';
import { cn } from '@/lib/utils';

interface OSUpdateCheckWidgetProps {
  widgetId: string;
  serverId: string;
}

interface Package {
  name: string;
  current_version: string;
  new_version: string;
  is_security: boolean;
}

interface OSUpdateData {
  updates_available: number;
  security_updates: number;
  packages: Package[];
  reboot_required: boolean;
  last_checked: string;
  os_type: string;
}

function timeAgo(dateString: string): string {
  const diff = Date.now() - new Date(dateString).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function OSUpdateCheckWidget({ widgetId, serverId }: OSUpdateCheckWidgetProps) {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<OSUpdateData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installResult, setInstallResult] = useState<string | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [showPackages, setShowPackages] = useState(false);
  const frame = useWidgetFrame();

  const checkForUpdates = useCallback(async (force = false) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithAuth(`/api/widgets/${widgetId}/data${force ? '?force=true' : ''}`);
      const json = await res.json();
      if (json.data) {
        setData(json.data);
      } else if (json.error) {
        setError(json.error.message || 'Failed to check for updates');
      }
    } catch {
      setError('Failed to check for updates');
    } finally {
      setLoading(false);
    }
  }, [widgetId]);

  // Load data on mount
  useEffect(() => {
    checkForUpdates();
  }, [checkForUpdates]);

  // The frame's Refresh action forces a re-check.
  useEffect(() => {
    if (!frame) return;
    return frame.registerRefresh(() => checkForUpdates(true));
  }, [frame, checkForUpdates]);

  const handleInstall = async () => {
    setShowConfirm(false);
    setInstalling(true);
    setInstallResult(null);
    try {
      const res = await fetchWithAuth(`/api/widgets/${widgetId}/data`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'install' }),
      });
      const json = await res.json();
      if (json.data?.success) {
        setInstallResult(json.data.message || 'Updates installed successfully');
        setData(null);
        // Refresh after install
        setTimeout(() => checkForUpdates(true), 3000);
      } else {
        setInstallResult(json.error?.message || 'Failed to install updates');
      }
    } catch {
      setInstallResult('Failed to install updates');
    } finally {
      setInstalling(false);
    }
  };

  if (!data) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-2 text-center">
        <div className="text-sm text-muted-foreground">{loading ? 'Checking…' : 'No data yet'}</div>
        {error && <div role="alert" className="text-xs text-destructive">{error}</div>}
        {installResult && <div className="text-xs">{installResult}</div>}
        <Button onClick={() => checkForUpdates(true)} disabled={loading} className="w-full max-w-xs">
          {loading ? 'Checking…' : 'Check for updates'}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 @xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="space-y-1.5 text-sm">
          {data.updates_available === 0 ? (
            <div className="flex items-center gap-1.5 font-medium text-success">
              <CircleCheck className="size-4" aria-hidden /> System up to date
            </div>
          ) : (
            <div className="flex items-center gap-1.5 font-medium text-warning">
              <Package className="size-4" aria-hidden /> {data.updates_available} updates available
            </div>
          )}
          {data.security_updates > 0 && (
            <div className="flex items-center gap-1.5 text-destructive">
              <ShieldAlert className="size-4" aria-hidden /> {data.security_updates} security updates
            </div>
          )}
          {data.reboot_required && (
            <div className="flex items-center gap-1.5 font-medium text-warning">
              <RotateCcw className="size-4" aria-hidden /> Reboot required
            </div>
          )}
          {data.last_checked && <div className="text-xs text-muted-foreground">Last checked: {timeAgo(data.last_checked)}</div>}
        </div>

        <div className="flex flex-col gap-2 @xl:items-end">
          {data.updates_available > 0 && (
            <Button onClick={() => setShowConfirm(true)} disabled={installing} className="w-full @xl:w-auto">
              {installing ? 'Installing…' : 'Install updates'}
            </Button>
          )}
          <Button onClick={() => checkForUpdates(true)} disabled={loading} variant="outline" className="w-full @xl:w-auto">
            {loading ? 'Checking…' : 'Check for updates'}
          </Button>
        </div>
      </div>

      {error && <div role="alert" className="text-xs text-destructive">{error}</div>}
      {installResult && <div className="text-xs">{installResult}</div>}

      {/* Expandable package list */}
      {data.packages && data.packages.length > 0 && (
        <div className="flex min-h-0 flex-col">
          <button
            type="button"
            onClick={() => setShowPackages(!showPackages)}
            aria-expanded={showPackages}
            className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            {showPackages ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
            {showPackages ? 'Hide' : 'Show'} {data.packages.length} packages
          </button>
          {showPackages && (
            <ul className="mt-1 min-h-0 flex-1 space-y-0.5 overflow-auto text-xs">
              {data.packages.map((pkg, i) => (
                <li key={i} className={cn('flex flex-wrap gap-x-1', pkg.is_security ? 'text-destructive' : 'text-muted-foreground')}>
                  <span className="font-medium">{pkg.name}</span>
                  <span className="break-all">
                    {pkg.current_version} → {pkg.new_version}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Confirmation overlay, scoped to the widget body */}
      {showConfirm && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/80 p-3 backdrop-blur-sm">
          <div role="alertdialog" aria-modal="true" aria-labelledby={`osu-confirm-${widgetId}`} className="w-full max-w-sm rounded-lg border border-destructive/50 bg-popover p-4 shadow-lg">
            <p id={`osu-confirm-${widgetId}`} className="flex items-center gap-1.5 text-sm font-medium text-destructive">
              <TriangleAlert className="size-4" aria-hidden /> Install OS updates?
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              This will install {data.updates_available} updates. The server may require a reboot afterward. This action will be logged.
            </p>
            <div className="mt-3 flex flex-wrap justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setShowConfirm(false)}>
                Cancel
              </Button>
              <Button variant="destructive" size="sm" onClick={handleInstall} disabled={installing}>
                {installing ? 'Installing…' : 'Install'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
