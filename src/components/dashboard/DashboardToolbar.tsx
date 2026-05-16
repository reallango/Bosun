'use client';

import { useState } from 'react';

interface DashboardToolbarProps {
  name: string;
  serverName?: string;
  type?: string;
  onAddWidget: () => void;
}

export function DashboardToolbar({ name, serverName, type, onAddWidget }: DashboardToolbarProps) {
  return (
    <div className="flex items-center justify-between mb-4">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-bold">{name}</h1>
        {serverName && (
          <span className="px-2 py-1 bg-gray-100 dark:bg-gray-700 rounded text-sm">{serverName}</span>
        )}
      </div>
      <button onClick={onAddWidget} className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700">
        + Add Widget
      </button>
    </div>
  );
}