'use client';

interface CircularGaugeProps {
  value: number;
  label: string;
  size?: number;
}

export function CircularGauge({ value, label, size = 80 }: CircularGaugeProps) {
  const radius = (size - 10) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (value / 100) * circumference;
  
  const color = value > 80 ? '#ef4444' : value > 50 ? '#eab308' : '#22c55e';

  return (
    <div className="flex flex-col items-center">
      <svg width={size} height={size} className="transform -rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="#e5e7eb"
          strokeWidth="8"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth="8"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
        />
      </svg>
      <span className="text-sm mt-1">{label}: {Math.round(value)}%</span>
    </div>
  );
}