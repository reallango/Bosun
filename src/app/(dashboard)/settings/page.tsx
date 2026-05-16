'use client';

import { useState, useEffect } from 'react';
import Header from '@/components/layout/Header';
import { useAuth } from '@/hooks/useAuth';

export default function SettingsPage() {
  const { user } = useAuth();
  const [appName] = useState('Bosun');
  const [ saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      // API call would go here
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Header title="Settings" />
      <div className="p-8 max-w-2xl">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold mb-4">General Settings</h2>
          
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1">Application Name</label>
              <input
                type="text"
                value={appName}
                readOnly
                className="w-full px-3 py-2 border rounded bg-gray-50 dark:bg-gray-700"
              />
            </div>
            
            <div>
              <label className="block text-sm font-medium mb-1">Current User</label>
              <input
                type="text"
                value={user?.username || ''}
                readOnly
                className="w-full px-3 py-2 border rounded bg-gray-50 dark:bg-gray-700"
              />
            </div>
            
            <div>
              <label className="block text-sm font-medium mb-1">Role</label>
              <input
                type="text"
                value={user?.role || ''}
                readOnly
                className="w-full px-3 py-2 border rounded bg-gray-50 dark:bg-gray-700"
              />
            </div>
          </div>
        </div>
      </div>
    </>
  );
}