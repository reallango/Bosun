interface StatusBadgeProps {
  status: 'online' | 'offline' | 'running' | 'stopped' | 'error' | 'unknown';
}

export function StatusBadge({ status }: StatusBadgeProps) {
  const config = {
    online: { color: 'bg-green-500', text: 'Online' },
    offline: { color: 'bg-red-500', text: 'Offline' },
    running: { color: 'bg-green-500', text: 'Running' },
    stopped: { color: 'bg-red-500', text: 'Stopped' },
    error: { color: 'bg-red-500', text: 'Error' },
    unknown: { color: 'bg-gray-400', text: 'Unknown' },
  };

  const { color, text } = config[status] || config.unknown;

  return (
    <span className="inline-flex items-center gap-1.5 text-sm">
      <span className={`w-2 h-2 rounded-full ${color}`} />
      <span className="text-gray-600 dark:text-gray-400">{text}</span>
    </span>
  );
}