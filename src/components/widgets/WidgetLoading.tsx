// src/components/widgets/WidgetLoading.tsx
'use client';

export function WidgetLoading({ label = 'Loading data…' }: { label?: string }) {
    return (
        <div className="flex h-full min-h-16 flex-col items-center justify-center gap-2 p-2" role="status">
            <div className="size-6 animate-spin rounded-full border-2 border-muted border-t-primary motion-reduce:animate-none" />
            <div className="text-xs text-muted-foreground">{label}</div>
        </div>
    );
}
