import Header from '@/components/layout/Header';

export default function HomePage() {
  return (
    <>
      <Header title="Dashboard" />
      <div className="p-8">
        <div className="bg-white rounded-lg shadow p-8 text-center">
          <h2 className="text-2xl font-bold text-gray-900 mb-4">Welcome to Bosun</h2>
          <p className="text-gray-600 mb-4">
            Add servers in Settings to start managing your infrastructure.
          </p>
        </div>
      </div>
    </>
  );
}