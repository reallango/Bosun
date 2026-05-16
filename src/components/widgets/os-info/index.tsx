'use client';

import { useState } from 'react';

export function OSInfoWidget({ serverId }: { serverId: string }) {
  const [loading, setLoading] = useState(false);
  const [updates, setUpdates] = useState(0);

  const checkUpdates = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/servers/${serverId}/updates/check`, { method: 'POST' });
      const json = await res.json();
      setUpdates(json.data?.updatesAvailable || 0);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="text-sm">
        <div>OS: Ubuntu 22.04</div>
        <div>Kernel: 5.15.0</div>
        <div>Hostname: server</div>
      </div>
      <button onClick={checkUpdates} disabled={loading} className="text-sm px-2 py-1 border rounded">
        {loading ? 'Checking...' : `Check Updates${updates > 0 ? ` (${updates})` : ''}`}
      </button>
    </div>
  );
}