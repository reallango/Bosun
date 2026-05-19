'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';

interface OSUpdateCheckWidgetProps {
  widgetId: string;
  serverId: string;
}

interface UpdateInfo {
  updatesAvailable: number;
  packages: string[];
  lastCheck: string;
}

export function OSUpdateCheckWidget({ widgetId, serverId }: OSUpdateCheckWidgetProps) {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<UpdateInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installResult, setInstallResult] = useState<string | null>(null);

  const checkForUpdates = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithAuth(`/api/widgets/${widgetId}/data`);
      const json = await res.json();
      if (json.data) {
        setData(json.data);
      } else if (json.error) {
        setError(json.error.message || 'Failed to check for updates');
      }
    } catch (err) {
      setError('Failed to check for updates');
    } finally {
      setLoading(false);
    }
  };

  const installUpdates = async () => {
    if (!confirm('Install available updates? This may require a reboot.')) return;
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
        setData(null); // Clear cached data
      } else {
        setInstallResult(json.error?.message || 'Failed to install updates');
      }
    } catch (err) {
      setInstallResult('Failed to install updates');
    } finally {
      setInstalling(false);
    }
  };

  return (
    <div className="space-y-3">
      <Button 
        onClick={checkForUpdates} 
        disabled={loading}
        className="w-full"
      >
        {loading ? 'Checking...' : 'Check for Updates'}
      </Button>

      {error && (
        <div className="text-red-500 text-sm">{error}</div>
      )}

      {data && data.updatesAvailable > 0 && (
        <div className="space-y-2">
          <div className="text-green-600 text-sm font-medium">
            {data.updatesAvailable} update(s) available
          </div>
          <div className="text-xs text-gray-500 max-h-20 overflow-auto">
            {data.packages.slice(0, 5).join(', ')}
            {data.packages.length > 5 && `... +${data.packages.length - 5} more`}
          </div>
          <Button 
            onClick={installUpdates} 
            disabled={installing}
            variant="default"
            className="w-full"
          >
            {installing ? 'Installing...' : 'Install Updates'}
          </Button>
        </div>
      )}

      {data && data.updatesAvailable === 0 && (
        <div className="text-green-600 text-sm">
          System is up to date
        </div>
      )}

      {installResult && (
        <div className="text-sm">{installResult}</div>
      )}

      {data?.lastCheck && (
        <div className="text-xs text-gray-500">
          Last checked: {new Date(data.lastCheck).toLocaleString()}
        </div>
      )}
    </div>
  );
}