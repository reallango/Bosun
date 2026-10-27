import { Suspense } from 'react';
import ResetPasswordForm from '@/components/auth/ResetPasswordForm';
import { AuthBrand } from '@/components/settings/AuthBrand';

export default function ResetPasswordPage() {
  return (
    <>
      <AuthBrand subtitle="Multi-Server Management Dashboard" />
      <Suspense fallback={null}>
        <ResetPasswordForm />
      </Suspense>
    </>
  );
}
