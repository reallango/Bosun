'use client';

export interface LineChartPoint {
  x: number;
  y: number;
}

interface LineChartProps {
  points: LineChartPoint[];
  height?: number;
  stroke?: string;
  /** Format a y value for the axis labels. */
  formatY?: (v: number) => string;
}

/**
 * Minimal dependency-free line chart. Bosun has no charting library and a single
 * sparkline does not justify one; this renders an SVG with a viewBox so it scales
 * to its container.
 */
export function LineChart({ points, height = 220, stroke = '#3b82f6', formatY }: LineChartProps) {
  const width = 600;
  const pad = { top: 12, right: 16, bottom: 28, left: 56 };
  const fmt = formatY || ((v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2)));

  if (points.length === 0) {
    return <div className="text-sm text-muted-foreground py-8 text-center">No data points</div>;
  }

  const xs = points.map(p => p.x);
  const ys = points.map(p => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const sx = (x: number) => pad.left + ((x - minX) / spanX) * innerW;
  const sy = (y: number) => pad.top + innerH - ((y - minY) / spanY) * innerH;

  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(' ');

  // Three gridlines: bottom (min), middle, top (max).
  const gridYs = [maxY, (maxY + minY) / 2, minY];
  const timeLabel = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full" style={{ height }} role="img">
      {gridYs.map((gy, i) => (
        <g key={i}>
          <line x1={pad.left} y1={sy(gy)} x2={width - pad.right} y2={sy(gy)} stroke="currentColor" className="text-gray-200 dark:text-gray-700" strokeWidth={1} />
          <text x={pad.left - 6} y={sy(gy) + 4} textAnchor="end" className="fill-gray-500" fontSize={11}>{fmt(gy)}</text>
        </g>
      ))}
      {points.length === 1 ? (
        <circle cx={sx(points[0].x)} cy={sy(points[0].y)} r={3} fill={stroke} />
      ) : (
        <path d={path} fill="none" stroke={stroke} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      )}
      <text x={pad.left} y={height - 8} textAnchor="start" className="fill-gray-500" fontSize={11}>{timeLabel(minX)}</text>
      <text x={width - pad.right} y={height - 8} textAnchor="end" className="fill-gray-500" fontSize={11}>{timeLabel(maxX)}</text>
    </svg>
  );
}
