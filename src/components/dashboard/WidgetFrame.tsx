'use client';

import { useState } from 'react';

interface WidgetFrameProps {
  widgetId: string;
  widgetType: string;
  title: string;
  serverId: string;
  editable?: boolean;
}

export function WidgetFrame({ widgetId, widgetType, title, serverId, editable = false }: WidgetFrameProps) {
  const [menuOpen, setMenuOpen] = useState(false);

  const handleRemove = async () => {
    if (!confirm('Remove this widget?')) return;
    await fetch(`/api/widgets/${widgetId}`, { method: 'DELETE' });
    window.location.reload();
  };

  const handleRefresh = async () => {
    await fetch(`/api/widgets/${widgetId}/data?force=true`);
  };

  return (
    <div className="h-full bg-white dark:bg-gray-800 rounded-lg shadow-md border border-gray-200 dark:border-gray-700 flex flex-col">
      <div className={`flex items-center justify-between px-3 py-2 border-b border-gray-200 dark:border-gray-700 ${editable ? 'cursor-move drag-handle' : ''}`}>
        <span className="font-medium text-sm truncate">{title}</span>
        <div className="flex items-center gap-1">
          <span className="text-xs text-gray-500 mr-2">{serverId}</span>
          <button onClick={() => setMenuOpen(!menuOpen)} className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700">
            <span className="text-lg">⋮</span>
          </button>
        </div>
        {menuOpen && (
          <div className="absolute right-0 top-8 bg-white dark:bg-gray-800 border rounded shadow-lg z-10">
            <button onClick={handleRefresh} className="block w-full px-4 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700">
              Refresh
            </button>
            <button onClick={handleRemove} className="block w-full px-4 py-2 text-left text-sm text-red-600 hover:bg-gray-100 dark:hover:bg-gray-700">
              Remove
            </button>
          </div>
        )}
      </div>
      <div className="flex-1 p-3 overflow-auto">
        {/* Widget content rendered here */}
      </div>
    </div>
  );
}