'use client';

import { useEffect, useState } from 'react';
import Header from '@/components/layout/Header';
import { DashboardGrid } from '@/components/dashboard/DashboardGrid';
import { EmptyState } from '@/components/shared/EmptyState';
import { Widget } from '@/types/widget';
import { Dashboard } from '@/types/dashboard';

export default function HomePage() {
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [widgets, setWidgets] = useState<Widget[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchDashboard();
  }, []);

  const fetchDashboard = async () => {
    try {
      const res = await fetch('/api/dashboards?type=home');
      const json = await res.json();
      if (json.data?.dashboards?.length) {
        setDashboard(json.data.dashboards[0]);
        const widgetsRes = await fetch(`/api/dashboards/${json.data.dashboards[0].id}/widgets`);
        const widgetsJson = await widgetsRes.json();
        setWidgets(widgetsJson.data?.widgets || []);
      }
    } catch (error) {
      console.error('Failed to load dashboard:', error);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <>
        <Header title="Dashboard" />
        <div className="p-8">Loading...</div>
      </>
    );
  }

  return (
    <>
      <Header title="Dashboard" />
      <div className="p-8">
        <DashboardGrid
          dashboardId={dashboard?.id || 'home'}
          widgets={widgets}
          editable={true}
        />
      </div>
    </>
  );
}