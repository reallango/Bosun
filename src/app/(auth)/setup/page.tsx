import SetupForm from '@/components/settings/SetupForm';
import { AuthBrand } from '@/components/settings/AuthBrand';

export default function SetupPage() {
  return (
    <>
      <AuthBrand subtitle="Initial Setup" />
      <SetupForm />
    </>
  );
}
