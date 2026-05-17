// src/components/widgets/WidgetPlaceholder.tsx
'use client';

export function WidgetPlaceholder() {
    return (
        <div className="flex flex-col items-center justify-center h-full p-4">
            <div className="w-6 h-6 border-2 border-gray-300 border-t-gray-500 rounded-full animate-spin mb-3"></div>
            <div className="text-xs text-gray-400">Awaiting connection...</div>
        </div>
    );
}