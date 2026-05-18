'use client';
import { useState } from 'react';
import { useParams } from 'next/navigation';
import Header from '@/components/layout/Header';
import { DashboardGrid } from '@/components/dashboard/DashboardGrid';
import { DashboardToolbar } from '@/components/dashboard/DashboardToolbar';
import { AddWidgetModal } from '@/components/dashboard/AddWidgetModal';
import { useDashboard } from '@/hooks/useDashboard';

export default function CustomDashboardPage() {
    const { dashboardId } = useParams<{ dashboardId: string }>();
    const { dashboard, widgets, isLoading, addWidget, updateLayout, refresh } = useDashboard(dashboardId);
    const [modal, setModal] = useState(false);

    if (isLoading) {
        return <div><Header title="Dashboard" /><div className="p-6 text-muted-foreground">Loading...</div></div>;
    }
    if (!dashboard) {
        return <div><Header title="Not Found" /><div className="p-6 text-muted-foreground">Dashboard not found.</div></div>;
    }

    return (
        <div>
            <Header title={dashboard.name} />
            <div className="p-6">
                <DashboardToolbar name={dashboard.name} type="custom" onAddWidget={() => setModal(true)} />
                <DashboardGrid dashboardId={dashboardId} widgets={widgets} onLayoutChange={updateLayout} editable onWidgetRemoved={refresh} />
                <AddWidgetModal isOpen={modal} onClose={() => setModal(false)} dashboardId={dashboardId} onAdd={addWidget} />
            </div>
        </div>
    );
}