import { redirect } from 'next/navigation';
import { isSetupRequired } from '@/lib/auth/setup-state';

export const dynamic = 'force-dynamic';

/** Setup is a one-time flow: once it is done (or the node has accounts), go to login. */
export default async function SetupLayout({ children }: { children: React.ReactNode }) {
  if (!(await isSetupRequired())) redirect('/login');
  return <>{children}</>;
}
