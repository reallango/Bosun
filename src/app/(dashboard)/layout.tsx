import Sidebar from '@/components/layout/Sidebar';
import { ShellProvider } from '@/components/layout/ShellContext';
import { ClusterBanner } from '@/components/layout/ClusterBanner';
import { TooltipProvider } from '@/components/ui/tooltip';

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ShellProvider>
      <TooltipProvider delayDuration={200} skipDelayDuration={300}>
        <div className="flex min-h-dvh w-full">
          <Sidebar />
          <div className="flex min-w-0 flex-1 flex-col">
            <ClusterBanner />
            <main className="flex min-w-0 flex-1 flex-col">{children}</main>
          </div>
        </div>
      </TooltipProvider>
    </ShellProvider>
  );
}
