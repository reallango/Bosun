'use client';

interface DiskUsageWidgetProps {
  serverId: string;
}

export function DiskUsageWidget({ serverId }: DiskUsageWidgetProps) {
  const disks = [
    { mountPoint: '/', usedMB: 45000, totalMB: 100000, fsType: 'ext4' },
    { mountPoint: '/home', usedMB: 5000, totalMB: 20000, fsType: 'ext4' },
  ];

  return (
    <div className="space-y-2">
      {disks.map(d => {
        const percent = Math.round((d.usedMB / d.totalMB) * 100);
        const color = percent > 85 ? 'bg-red-500' : percent > 70 ? 'bg-yellow-500' : 'bg-green-500';
        
        return (
          <div key={d.mountPoint}>
            <div className="flex justify-between text-xs mb-1">
              <span>{d.mountPoint}</span>
              <span>{percent}%</span>
            </div>
            <div className="h-2 bg-gray-200 rounded overflow-hidden">
              <div className={`h-full ${color}`} style={{ width: `${percent}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}