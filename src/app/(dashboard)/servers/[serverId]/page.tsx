'use client';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Header from '@/components/layout/Header';
import { DashboardGrid } from '@/components/dashboard/DashboardGrid';
import { DashboardToolbar } from '@/components/dashboard/DashboardToolbar';
import { AddWidgetModal } from '@/components/dashboard/AddWidgetModal';
import { useDashboard } from '@/hooks/useDashboard';

export default function ServerDashboardPage() {
    const { serverId } = useParams<{ serverId: string }>();
    const [dashId, setDashId] = useState<string | null>(null);
    const [name, setName] = useState('');
    const [modal, setModal] = useState(false);

    useEffect(() => {
        fetch(`/api/servers/${serverId}`)
            .then(r => r.json())
            .then(j => { if (j.data) setName(j.data.name || j.data.hostname); })
            .catch(() => {});
        fetch('/api/dashboards')
            .then(r => r.json())
            .then(j => {
                const ds = j.data?.dashboards || j.data || [];
                const sd = ds.find((d: any) => d.type === 'server' && d.server_id === serverId);
                if (sd) setDashId(sd.id);
            })
            .catch(() => {});
    }, [serverId]);

    const { widgets, isLoading, addWidget, updateLayout, refresh } = useDashboard(dashId || '');

    if (!dashId || isLoading) {
        return <div><Header title="Server Dashboard" /><div className="p-6 text-muted-foreground">Loading...</div></div>;
    }

    return (
        <div>
            <Header title={name || 'Server'} />
            <div className="p-6">
                <DashboardToolbar name={name} serverName={name} type="server" onAddWidget={() => setModal(true)} serverId={serverId} />
                <DashboardGrid dashboardId={dashId} widgets={widgets} onLayoutChange={updateLayout} editable onWidgetRemoved={refresh} />
                <AddWidgetModal isOpen={modal} onClose={() => setModal(false)} dashboardId={dashId} serverId={serverId} onAdd={addWidget} />
            </div>
        </div>
    );
}