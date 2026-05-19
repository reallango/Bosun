'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';

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

export function OSUpdateCheckWidget({ widgetId, serverId }: OSUpdateCheckWidgetProps) {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<OSUpdateData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installResult, setInstallResult] = useState<string | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [showPackages, setShowPackages] = useState(false);

  // Load data on mount
  useEffect(() => {
    checkForUpdates();
  }, [widgetId]);

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
        setTimeout(checkForUpdates, 3000);
      } else {
        setInstallResult(json.error?.message || 'Failed to install updates');
      }
    } catch (err) {
      setInstallResult('Failed to install updates');
    } finally {
      setInstalling(false);
    }
  };

  if (!data) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-4">
        <div className="text-gray-500 text-sm mb-3">No data yet</div>
        <Button onClick={checkForUpdates} disabled={loading} className="w-full">
          {loading ? 'Checking...' : 'Check for Updates'}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3 p-2">
      {/* Update count with color coding */}
      {data.updates_available === 0 ? (
        <div className="text-green-600 font-medium text-sm">✅ System up to date</div>
      ) : (
        <div className="space-y-1">
          <div className="text-yellow-600 font-medium text-sm">
            📦 {data.updates_available} updates available
          </div>
          {data.security_updates > 0 && (
            <div className="text-red-500 text-sm">
              🔒 {data.security_updates} security updates
            </div>
          )}
        </div>
      )}

      {/* Reboot required indicator */}
      {data.reboot_required && (
        <div className="text-yellow-500 text-sm font-medium">⚠️ Reboot required</div>
      )}

      {/* Last checked relative timestamp */}
      {data.last_checked && (
        <div className="text-xs text-gray-500">Last checked: {timeAgo(data.last_checked)}</div>
      )}

      {/* Install button - only when updates available */}
      {data.updates_available > 0 && !showConfirm && (
        <Button onClick={() => setShowConfirm(true)} className="w-full">
          Install Updates
        </Button>
      )}

      {/* Styled confirmation dialog */}
      {showConfirm && (
        <div className="absolute inset-0 bg-black/70 flex items-center justify-center p-4 z-10 rounded-lg">
          <div className="bg-gray-800 border border-red-600 rounded-lg p-4 max-w-sm">
            <p className="text-red-400 font-medium text-sm">⚠️ Install OS Updates?</p>
            <p className="text-gray-300 text-xs mt-2">
              This will install {data.updates_available} updates.
              The server may require a reboot afterward.
            </p>
            <p className="text-gray-400 text-xs mt-1">This action will be logged.</p>
            <div className="flex gap-2 mt-3 justify-end">
              <button
                onClick={() => setShowConfirm(false)}
                className="px-3 py-1 text-xs bg-gray-700 text-gray-300 rounded hover:bg-gray-600"
              >
                Cancel
              </button>
              <button
                onClick={handleInstall}
                disabled={installing}
                className="px-3 py-1 text-xs bg-red-600 text-white rounded hover:bg-red-500"
              >
                {installing ? 'Installing...' : 'Install'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Expandable package list */}
      {data.packages && data.packages.length > 0 && (
        <div className="mt-2">
          <button
            onClick={() => setShowPackages(!showPackages)}
            className="text-xs text-gray-500 hover:text-gray-400"
          >
            {showPackages ? `Hide ${data.packages.length} packages ▲` : `Show ${data.packages.length} packages ▼`}
          </button>
          {showPackages && (
            <div className="mt-1 max-h-24 overflow-auto text-xs space-y-1">
              {data.packages.map((pkg, i) => (
                <div key={i} className={pkg.is_security ? 'text-red-400' : 'text-gray-400'}>
                  {pkg.name} {pkg.current_version} → {pkg.new_version}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Check button */}
      <Button onClick={checkForUpdates} disabled={loading} variant="outline" className="w-full mt-2">
        {loading ? 'Checking...' : 'Check for Updates'}
      </Button>

      {error && <div className="text-red-500 text-sm">{error}</div>}
      {installResult && <div className="text-sm">{installResult}</div>}
    </div>
  );
}