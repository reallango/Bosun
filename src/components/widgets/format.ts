/** Format a size given in MB as MB / GB / TB with sensible precision. */
export function formatMB(mb: unknown): string {
    const n = typeof mb === 'number' ? mb : Number(mb);
    if (!Number.isFinite(n)) return '–';
    if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} TB`;
    if (n >= 1024) return `${(n / 1024).toFixed(n >= 10240 ? 0 : 1)} GB`;
    return `${Math.round(n)} MB`;
}

export function pct(value: unknown): number {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(100, n));
}

/** Tailwind background class for a usage bar. */
export function usageColor(p: number): string {
    return p > 85 ? 'bg-red-500' : p > 70 ? 'bg-yellow-500' : 'bg-green-500';
}
