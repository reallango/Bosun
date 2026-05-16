import SetupForm from '@/components/settings/SetupForm';

export default function SetupPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="max-w-md w-full p-8">
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold text-gray-900">Bosun</h1>
          <p className="text-gray-600 mt-2">Initial Setup</p>
        </div>
        <SetupForm />
      </div>
    </div>
  );
}