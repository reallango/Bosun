'use client';

interface NetworkWidgetProps {
  serverId: string;
}

export function NetworkWidget({ serverId }: NetworkWidgetProps) {
  const interfaces = [
    { name: 'eth0', ipv4: ['192.168.1.100'], mac: '00:11:22:33:44:55', state: 'UP' },
    { name: 'eth1', ipv4: ['10.0.0.50'], mac: '00:11:22:33:44:56', state: 'UP' },
  ];

  return (
    <div className="space-y-1">
      {interfaces.map(i => (
        <div key={i.name} className="text-sm">
          <div className="flex justify-between">
            <span className="font-medium">{i.name}</span>
            <span className={`px-1 text-xs ${i.state === 'UP' ? 'text-green-600' : 'text-gray-500'}`}>{i.state}</span>
          </div>
          <div className="text-gray-500">{i.ipv4[0]}</div>
        </div>
      ))}
    </div>
  );
}