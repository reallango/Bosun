import LoginForm from '@/components/settings/LoginForm';
import { AuthBrand } from '@/components/settings/AuthBrand';

export default function LoginPage() {
  return (
    <>
      <AuthBrand subtitle="Multi-Server Management Dashboard" />
      <LoginForm />
    </>
  );
}
