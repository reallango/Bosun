'use client';

import { useState } from 'react';
import Header from '@/components/layout/Header';
import { DashboardGrid } from '@/components/dashboard/DashboardGrid';
import { DashboardToolbar } from '@/components/dashboard/DashboardToolbar';
import { AddWidgetModal } from '@/components/dashboard/AddWidgetModal';
import { useDashboard } from '@/hooks/useDashboard';

export default function HomePage() {
  const dashboardId = 'home';
  const { dashboard, widgets, isLoading, addWidget, updateLayout, refresh } = useDashboard(dashboardId);
  const [modal, setModal] = useState(false);

  if (isLoading) {
    return (
      <>
        <Header title="Dashboard" />
        <div className="p-8">Loading...</div>
      </>
    );
  }

  return (
    <>
      <Header title="Home" />
      <div className="p-8">
        <DashboardToolbar name="Home" type="home" onAddWidget={() => setModal(true)} />
        <DashboardGrid
          dashboardId={dashboardId}
          widgets={widgets}
          onLayoutChange={updateLayout}
          editable={true}
        />
        <AddWidgetModal isOpen={modal} onClose={() => setModal(false)} dashboardId={dashboardId} onAdd={addWidget} />
      </div>
    </>
  );
}