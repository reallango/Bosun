'use client';

import { useCallback, useState } from 'react';
import { useParams } from 'next/navigation';
import Header from '@/components/layout/Header';
import { DashboardView } from '@/components/dashboard/DashboardView';
import type { Dashboard } from '@/types/dashboard';

export default function CustomDashboardPage() {
    const { dashboardId } = useParams<{ dashboardId: string }>();
    const [name, setName] = useState<string | null>(null);

    const handleLoaded = useCallback((d: Dashboard | null) => setName(d?.name ?? null), []);

    return (
        <>
            <Header title={name ?? 'Dashboard'} />
            <div className="page">
                <DashboardView dashboardId={dashboardId} name={name ?? 'Dashboard'} type="custom" onDashboardLoaded={handleLoaded} />
            </div>
        </>
    );
}
