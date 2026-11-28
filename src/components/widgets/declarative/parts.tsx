'use client';

import { forwardRef } from 'react';
import { Copy, Download, ExternalLink, Info, Layers, Pause, Pencil, Play, Plus, Power, RefreshCw, RotateCw, ScrollText, Settings, Square, TerminalSquare, Trash2, Upload } from 'lucide-react';
import { evalCond, fillTemplate, type FieldSpec } from '@/lib/widgets/runtime/spec';
import { formatValue } from '@/lib/widgets/runtime/number-format';
import { fitsSize } from '@/lib/widgets/runtime/size';
import { shapeSparkline, sparklinePath, trendWindowSec, type TrendSpec } from '@/lib/widgets/runtime/trends';
import { useWidgetSize } from '@/components/dashboard/widget-size';
import { useTrendData } from './trends';
import { iconButtonClass, SPARKLINE } from './styles';

/** Small pieces shared by the version 1 views and the layout blocks of the declarative widget. */

export const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  play: Play, square: Square, 'rotate-cw': RotateCw, 'scroll-text': ScrollText, 'trash-2': Trash2, download: Download, upload: Upload,
  power: Power, 'refresh-cw': RefreshCw, 'terminal-square': TerminalSquare, pause: Pause, info: Info,
  pencil: Pencil, plus: Plus, copy: Copy, settings: Settings, 'external-link': ExternalLink, layers: Layers,
};

export const DOT: Record<string, string> = {
  green: 'bg-green-500', amber: 'bg-amber-500', red: 'bg-red-500', gray: 'bg-muted-foreground', blue: 'bg-primary',
};

export type Row = Record<string, unknown>;

export { formatValue };

/** Bar colour by how full it is. */
function barColor(pct: number): string {
  return pct >= 90 ? 'bg-red-500' : pct >= 75 ? 'bg-amber-500' : 'bg-green-500';
}

export type StatToneName = 'warning' | 'danger' | 'success';

const TONE_BAR: Record<StatToneName, string> = { danger: 'bg-destructive', warning: 'bg-warning', success: 'bg-success' };

export function Bar({ value, color, tone }: { value: number; color?: string; tone?: StatToneName | null }) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div className="h-1.5 w-full overflow-hidden rounded bg-muted" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <div className={`h-full ${color ?? (tone ? TONE_BAR[tone] : barColor(pct))}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

/** A small line of a metric's recent history. It draws nothing when the host has no history for it. */
export function Sparkline({ trend, tone }: { trend: TrendSpec; tone?: StatToneName | null }) {
  const data = useTrendData();
  const points = data ? shapeSparkline(data.series[trend.metric] ?? [], trendWindowSec(trend.window), data.to) : [];
  if (points.length < 2) return null;
  const stroke = tone === 'danger' ? 'stroke-destructive' : tone === 'warning' ? 'stroke-warning' : tone === 'success' ? 'stroke-success' : 'stroke-primary';
  return (
    <svg viewBox="0 0 100 30" preserveAspectRatio="none" className={SPARKLINE} aria-hidden="true">
      <path d={sparklinePath(points)} fill="none" strokeWidth={1.5} vectorEffect="non-scaling-stroke" className={stroke} />
    </svg>
  );
}

/** Labelled values of one object: gauges for the ones with a `bar`, plain pairs for the rest. */
export function Fields({ fields, data }: { fields: FieldSpec[]; data: unknown }) {
  const { size } = useWidgetSize();
  const shown = fields.filter(f => fitsSize(f, size) && (!f.when || evalCond(f.when, data)));
  return (
    <div className="space-y-1.5">
      {shown.map(f => {
        const text = formatValue(fillTemplate(f.value, data), f.format);
        const bar = f.bar ? Number(fillTemplate(f.bar, data)) : NaN;
        return (
          <div key={f.label}>
            <div className="flex items-baseline justify-between gap-2 text-xs">
              <span className="text-muted-foreground">{f.label}</span>
              <span className="truncate font-medium text-foreground">{text || '—'}</span>
            </div>
            {Number.isFinite(bar) && <Bar value={bar} />}
            {f.trend && <Sparkline trend={f.trend} />}
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
      className={`${iconButtonClass} [&_svg]:size-3.5 ${className || ''}`}>
      {children}
    </button>
  );
});
