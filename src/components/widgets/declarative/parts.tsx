'use client';

import { forwardRef } from 'react';
import { Download, Info, Pause, Play, Power, RefreshCw, RotateCw, ScrollText, Square, TerminalSquare, Trash2, Upload } from 'lucide-react';
import { evalCond, fillTemplate, type FieldSpec } from '@/lib/widgets/runtime/spec';

/** Small pieces shared by the version 1 views and the layout blocks of the declarative widget. */

export const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  play: Play, square: Square, 'rotate-cw': RotateCw, 'scroll-text': ScrollText, 'trash-2': Trash2, download: Download, upload: Upload,
  power: Power, 'refresh-cw': RefreshCw, 'terminal-square': TerminalSquare, pause: Pause, info: Info,
};

export const DOT: Record<string, string> = {
  green: 'bg-green-500', amber: 'bg-amber-500', red: 'bg-red-500', gray: 'bg-gray-400', blue: 'bg-blue-500',
};

export type Row = Record<string, unknown>;

export function formatValue(v: unknown, format: string): string {
  if (v === undefined || v === null || v === '') return '';
  const n = Number(v);
  if (format === 'bytes' && Number.isFinite(n)) {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let x = n;
    let i = 0;
    while (x >= 1024 && i < units.length - 1) { x /= 1024; i++; }
    return `${x >= 10 || i === 0 ? Math.round(x) : x.toFixed(1)} ${units[i]}`;
  }
  if ((format === 'percent' || format === 'bar') && Number.isFinite(n)) return `${Math.round(n * 10) / 10}%`;
  if (format === 'mb' && Number.isFinite(n)) return n >= 1024 ? `${(n / 1024).toFixed(1)} GB` : `${Math.round(n)} MB`;
  if (format === 'temp' && Number.isFinite(n)) return `${Math.round(n)}°C`;
  if (format === 'duration' && Number.isFinite(n)) {
    const d = Math.floor(n / 86400), h = Math.floor((n % 86400) / 3600), m = Math.floor((n % 3600) / 60);
    return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
  }
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

/** Bar colour by how full it is. */
function barColor(pct: number): string {
  return pct >= 90 ? 'bg-red-500' : pct >= 75 ? 'bg-amber-500' : 'bg-green-500';
}

export function Bar({ value, color }: { value: number; color?: string }) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div className="h-1.5 w-full overflow-hidden rounded bg-gray-200 dark:bg-gray-700" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <div className={`h-full ${color ?? barColor(pct)}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

/** Labelled values of one object: gauges for the ones with a `bar`, plain pairs for the rest. */
export function Fields({ fields, data }: { fields: FieldSpec[]; data: unknown }) {
  const shown = fields.filter(f => !f.when || evalCond(f.when, data));
  return (
    <div className="space-y-1.5">
      {shown.map(f => {
        const text = formatValue(fillTemplate(f.value, data), f.format);
        const bar = f.bar ? Number(fillTemplate(f.bar, data)) : NaN;
        return (
          <div key={f.label}>
            <div className="flex items-baseline justify-between gap-2 text-xs">
              <span className="text-gray-500">{f.label}</span>
              <span className="truncate font-medium text-gray-900 dark:text-gray-100">{text || '—'}</span>
            </div>
            {Number.isFinite(bar) && <Bar value={bar} />}
          </div>
        );
      })}
    </div>
  );
}

type IconBtnProps = React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string };

export const IconBtn = forwardRef<HTMLButtonElement, IconBtnProps>(function IconBtn({ label, children, className, ...rest }, ref) {
  return (
    <button ref={ref} type="button" aria-label={label} title={label} {...rest}
      className={`rounded p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-900 disabled:opacity-40 dark:hover:bg-gray-800 dark:hover:text-gray-100 [&_svg]:size-3.5 ${className || ''}`}>
      {children}
    </button>
  );
});
