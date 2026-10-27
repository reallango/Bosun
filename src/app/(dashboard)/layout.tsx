import Sidebar from '@/components/layout/Sidebar';
import { ShellProvider } from '@/components/layout/ShellContext';
import { ClusterBanner } from '@/components/layout/ClusterBanner';

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ShellProvider>
      <div className="flex min-h-dvh w-full">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <ClusterBanner />
          <main className="flex min-w-0 flex-1 flex-col">{children}</main>
        </div>
      </div>
    </ShellProvider>
  );
}
