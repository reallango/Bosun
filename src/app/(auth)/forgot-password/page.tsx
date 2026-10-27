import ForgotPasswordForm from '@/components/auth/ForgotPasswordForm';
import { AuthBrand } from '@/components/settings/AuthBrand';

export default function ForgotPasswordPage() {
  return (
    <>
      <AuthBrand subtitle="Multi-Server Management Dashboard" />
      <ForgotPasswordForm />
    </>
  );
}
