// src/components/widgets/WidgetError.tsx
'use client';

import { CircleHelp, KeyRound, Lock, RefreshCw, TriangleAlert, WifiOff, type LucideIcon } from 'lucide-react';

interface WidgetErrorProps {
    error: string;
    onRetry?: () => void;
    serverId?: string;
}

function getErrorDisplay(error: string): { icon: LucideIcon; title: string; description: string; actionHint?: string } {
    const lowerError = error.toLowerCase();

    if (lowerError.includes('no ssh key') || lowerError.includes('key not found')) {
        return {
            icon: KeyRound,
            title: 'SSH Key Required',
            description: 'This server needs an SSH key configured to collect data.',
            actionHint: 'Configure in Settings > Servers',
        };
    }

    if (lowerError.includes('server not found')) {
        return {
            icon: CircleHelp,
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
            icon: WifiOff,
            title: 'Server Unreachable',
            description: 'Cannot connect to this server. It may be offline.',
        };
    }

    if (lowerError.includes('authentication') ||
        lowerError.includes('permission denied') ||
        lowerError.includes('auth fail')) {
        return {
            icon: Lock,
            title: 'Authentication Failed',
            description: 'SSH credentials were rejected by the server.',
            actionHint: 'Check SSH key and username in Settings',
        };
    }

    return {
        icon: TriangleAlert,
        title: 'Data Unavailable',
        description: error.length > 120 ? error.substring(0, 120) + '…' : error,
    };
}

export function WidgetError({ error, onRetry }: WidgetErrorProps) {
    const display = getErrorDisplay(error);
    const Icon = display.icon;

    return (
        <div role="alert" className="flex h-full min-h-16 flex-col items-center justify-center gap-1 p-2 text-center">
            <Icon className="mb-1 size-6 text-muted-foreground @[12rem]:size-7" aria-hidden />
            <div className="text-sm font-medium">{display.title}</div>
            <div className="hidden max-w-xs break-words text-xs text-muted-foreground @[10rem]:block" title={error}>
                {display.description}
            </div>
            {display.actionHint && <div className="hidden text-xs text-primary @[12rem]:block">{display.actionHint}</div>}
            {onRetry && (
                <button
                    type="button"
                    onClick={onRetry}
                    className="mt-1 inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                    <RefreshCw className="size-3" aria-hidden />
                    Retry
                </button>
            )}
        </div>
    );
}
