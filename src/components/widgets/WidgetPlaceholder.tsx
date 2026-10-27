// src/components/widgets/WidgetPlaceholder.tsx
'use client';

export function WidgetPlaceholder({ label = 'Awaiting connection…' }: { label?: string }) {
    return (
        <div className="flex h-full min-h-16 flex-col items-center justify-center gap-2 p-2" role="status">
            <div className="size-5 animate-spin rounded-full border-2 border-muted border-t-muted-foreground motion-reduce:animate-none" />
            <div className="text-xs text-muted-foreground">{label}</div>
        </div>
    );
}

/** Consistent "nothing to show" state inside a widget. */
export function WidgetEmpty({ children }: { children: React.ReactNode }) {
    return <div className="flex h-full min-h-12 items-center justify-center p-2 text-center text-xs text-muted-foreground">{children}</div>;
}
