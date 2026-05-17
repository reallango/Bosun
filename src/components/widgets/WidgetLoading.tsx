// src/components/widgets/WidgetLoading.tsx
'use client';

export function WidgetLoading() {
    return (
        <div className="flex flex-col items-center justify-center h-full p-4">
            <div className="w-8 h-8 border-2 border-blue-200 border-t-blue-600 rounded-full animate-spin mb-3"></div>
            <div className="text-xs text-gray-500">Loading data...</div>
        </div>
    );
}