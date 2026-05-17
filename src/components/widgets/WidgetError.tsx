// src/components/widgets/WidgetError.tsx
'use client';

interface WidgetErrorProps {
    error: string;
    onRetry?: () => void;
    serverId?: string;
}

function getErrorDisplay(error: string): { icon: string; title: string; description: string; actionHint?: string } {
    const lowerError = error.toLowerCase();

    if (lowerError.includes('no ssh key') || lowerError.includes('key not found')) {
        return {
            icon: '🔑',
            title: 'SSH Key Required',
            description: 'This server needs an SSH key configured to collect data.',
            actionHint: 'Configure in Settings > Servers',
        };
    }

    if (lowerError.includes('server not found')) {
        return {
            icon: '❓',
            title: 'Server Not Found',
            description: 'The server associated with this widget no longer exists.',
        };
    }

    if (lowerError.includes('connection refused') ||
        lowerError.includes('econnrefused') ||
        lowerError.includes('timeout') ||
        lowerError.includes('etimedout') ||
        lowerError.includes('ehostunreach')) {
        return {
            icon: '📡',
            title: 'Server Unreachable',
            description: 'Cannot connect to this server. It may be offline.',
        };
    }

    if (lowerError.includes('authentication') ||
        lowerError.includes('permission denied') ||
        lowerError.includes('auth fail')) {
        return {
            icon: '🔒',
            title: 'Authentication Failed',
            description: 'SSH credentials were rejected by the server.',
            actionHint: 'Check SSH key and username in Settings',
        };
    }

    return {
        icon: '⚠️',
        title: 'Data Unavailable',
        description: error.length > 80 ? error.substring(0, 80) + '...' : error,
    };
}

export function WidgetError({ error, onRetry, serverId }: WidgetErrorProps) {
    const display = getErrorDisplay(error);

    return (
        <div className="flex flex-col items-center justify-center h-full text-center p-4">
            <div className="text-3xl mb-2">{display.icon}</div>
            <div className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                {display.title}
            </div>
            <div className="text-xs text-gray-500 dark:text-gray-400 mb-3">
                {display.description}
            </div>
            {display.actionHint && (
                <div className="text-xs text-blue-500 mb-2">{display.actionHint}</div>
            )}
            {onRetry && (
                <button
                    onClick={onRetry}
                    className="px-3 py-1 text-xs bg-gray-100 dark:bg-gray-700 rounded hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
                >
                    Retry
                </button>
            )}
        </div>
    );
}