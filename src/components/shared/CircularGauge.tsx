'use client';

import { cn } from '@/lib/utils';

interface CircularGaugeProps {
  value: number;
  label: string;
  /** Max rendered size in px; the gauge shrinks with its container below that. */
  size?: number;
  className?: string;
}

export function gaugeColor(value: number) {
  return value > 80 ? '#ef4444' : value > 50 ? '#eab308' : '#22c55e';
}

export function CircularGauge({ value, label, size = 96, className }: CircularGaugeProps) {
  const v = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
  const box = 100;
  const stroke = 10;
  const radius = (box - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (v / 100) * circumference;

  return (
    <div className={cn('flex min-w-0 flex-col items-center', className)}>
      <div className="relative w-full" style={{ maxWidth: size }}>
        <svg viewBox={`0 0 ${box} ${box}`} className="block h-auto w-full -rotate-90" role="img" aria-label={`${label} ${Math.round(v)}%`}>
          <circle cx={box / 2} cy={box / 2} r={radius} fill="none" className="stroke-muted" strokeWidth={stroke} />
          <circle
            cx={box / 2}
            cy={box / 2}
            r={radius}
            fill="none"
            stroke={gaugeColor(v)}
            strokeWidth={stroke}
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            strokeLinecap="round"
            className="transition-[stroke-dashoffset] duration-500 motion-reduce:transition-none"
          />
        </svg>
        <span className="absolute inset-0 flex items-center justify-center text-sm font-semibold tabular-nums @[10rem]:text-base">
          {Math.round(v)}%
        </span>
      </div>
      <span className="mt-1 text-xs text-muted-foreground">{label}</span>
    </div>
  );
}
