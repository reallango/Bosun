import { redirect } from 'next/navigation';
import LoginForm from '@/components/settings/LoginForm';
import { AuthBrand } from '@/components/settings/AuthBrand';
import { isSetupRequired } from '@/lib/auth/setup-state';

export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  if (await isSetupRequired()) redirect('/setup');
  return (
    <>
      <AuthBrand subtitle="Multi-Server Management Dashboard" />
      <LoginForm />
    </>
  );
}
