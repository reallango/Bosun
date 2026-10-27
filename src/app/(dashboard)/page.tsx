'use client';

import Header from '@/components/layout/Header';
import { DashboardView } from '@/components/dashboard/DashboardView';

export default function HomePage() {
  return (
    <>
      <Header title="Home" />
      <div className="page">
        <DashboardView dashboardId="home" name="Home" type="home" />
      </div>
    </>
  );
}
