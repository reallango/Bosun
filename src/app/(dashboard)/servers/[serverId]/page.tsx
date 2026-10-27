'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Header from '@/components/layout/Header';
import { DashboardView } from '@/components/dashboard/DashboardView';
import { LoadingSpinner } from '@/components/shared/LoadingSpinner';
import { EmptyState } from '@/components/shared/EmptyState';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import { ensureArray } from '@/lib/api/ensureArray';

interface DashboardRow {
    id: string;
    type: string;
    server_id: string | null;
}

export default function ServerDashboardPage() {
    const { serverId } = useParams<{ serverId: string }>();
    const [dashId, setDashId] = useState<string | null>(null);
    const [name, setName] = useState('');
    const [missing, setMissing] = useState(false);

    useEffect(() => {
        let cancelled = false;
        setDashId(null);
        setMissing(false);
        fetchWithAuth(`/api/servers/${serverId}`)
            .then(r => r.json())
            .then(j => {
                const s = j?.data?.server ?? j?.data;
                if (!cancelled && s) setName(s.name || s.hostname || '');
            })
            .catch(() => {});
        fetchWithAuth('/api/dashboards')
            .then(r => r.json())
            .then(j => {
                if (cancelled) return;
                const ds = ensureArray<DashboardRow>(j?.data?.dashboards ?? j?.data);
                const sd = ds.find(d => d.type === 'server' && d.server_id === serverId);
                if (sd) setDashId(sd.id);
                else setMissing(true);
            })
            .catch(() => {
                if (!cancelled) setMissing(true);
            });
        return () => {
            cancelled = true;
        };
    }, [serverId]);

    return (
        <>
            <Header title={name || 'Server'} />
            <div className="page">
                {missing ? (
                    <EmptyState title="No dashboard for this server" description="The server dashboard could not be found." />
                ) : !dashId ? (
                    <LoadingSpinner />
                ) : (
                    <DashboardView dashboardId={dashId} name={name || 'Server'} type="server" serverId={serverId} serverName={name} />
                )}
            </div>
        </>
    );
}
