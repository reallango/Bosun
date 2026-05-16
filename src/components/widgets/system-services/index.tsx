'use client';

import { useState } from 'react';
import { StatusBadge } from '@/components/shared/StatusBadge';

interface SystemServicesWidgetProps {
  serverId: string;
}

export function SystemServicesWidget({ serverId }: SystemServicesWidgetProps) {
  const services = [
    { name: 'ssh', status: 'running', description: 'OpenSSH server' },
    { name: 'nginx', status: 'running', description: 'Web server' },
    { name: 'docker', status: 'running', description: 'Docker daemon' },
  ];

  return (
    <div className="space-y-1">
      {services.map(s => (
        <div key={s.name} className="flex items-center justify-between text-sm">
          <div>
            <span className="font-medium">{s.name}</span>
            <span className="text-gray-500 ml-2">{s.description}</span>
          </div>
          <StatusBadge status={s.status === 'running' ? 'running' : 'stopped'} />
        </div>
      ))}
    </div>
  );
}