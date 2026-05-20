'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';

interface AlertRule {
  id: string;
  name: string;
  metric: string;
  condition: string;
  threshold: number;
  cooldown_seconds: number;
  enabled: boolean;
}

interface NotificationChannel {
  id: string;
  type: string;
  name: string;
}

export default function AlertsPage() {
  const router = useRouter();
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [channels, setChannels] = useState<NotificationChannel[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: '', metric: 'cpu', condition: 'gt', threshold: 80, cooldown_seconds: 300, channel_ids: [] as string[], enabled: true });

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    const [rulesRes, channelsRes] = await Promise.all([
      fetchWithAuth('/api/alert-rules'),
      fetchWithAuth('/api/notification-channels')
    ]);
    const rulesJson = await rulesRes.json();
    const channelsJson = await channelsRes.json();
    setRules(rulesJson?.data?.rules || []);
    setChannels(channelsJson?.data?.channels || []);
    setLoading(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await fetchWithAuth('/api/alert-rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form)
    });
    setShowForm(false);
    fetchData();
  };

  const toggleRule = async (id: string, enabled: boolean) => {
    await fetchWithAuth(`/api/alert-rules/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled })
    });
    fetchData();
  };

  const deleteRule = async (id: string) => {
    await fetchWithAuth(`/api/alert-rules/${id}`, { method: 'DELETE' });
    fetchData();
  };

  if (loading) return <div className="p-6">Loading...</div>;

  return (
    <div className="p-6">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">Alert Rules</h1>
        <button onClick={() => setShowForm(true)} className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700">
          + Add Alert Rule
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleSubmit} className="mb-6 p-4 bg-gray-50 dark:bg-gray-800 rounded-lg border">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">Name</label>
              <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} className="w-full border rounded px-3 py-2 bg-white dark:bg-gray-700 text-gray-900 dark:text-white border-gray-300 dark:border-gray-600" required />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Metric</label>
              <select value={form.metric} onChange={e => setForm({ ...form, metric: e.target.value })} className="w-full border rounded px-3 py-2 bg-white dark:bg-gray-700 text-gray-900 dark:text-white border-gray-300 dark:border-gray-600">
                <option value="cpu">CPU Usage</option>
                <option value="memory">Memory Usage</option>
                <option value="disk">Disk Usage</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Condition</label>
              <select value={form.condition} onChange={e => setForm({ ...form, condition: e.target.value })} className="w-full border rounded px-3 py-2 bg-white dark:bg-gray-700 text-gray-900 dark:text-white border-gray-300 dark:border-gray-600">
                <option value="gt">&gt; Greater than</option>
                <option value="lt">&lt; Less than</option>
                <option value="gte">≥ Greater or equal</option>
                <option value="lte">≤ Less or equal</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Threshold</label>
              <input type="number" value={form.threshold} onChange={e => setForm({ ...form, threshold: Number(e.target.value) })} className="w-full border rounded px-3 py-2 bg-white dark:bg-gray-700 text-gray-900 dark:text-white border-gray-300 dark:border-gray-600" />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Cooldown (seconds)</label>
              <input type="number" value={form.cooldown_seconds} onChange={e => setForm({ ...form, cooldown_seconds: Number(e.target.value) })} className="w-full border rounded px-3 py-2 bg-white dark:bg-gray-700 text-gray-900 dark:text-white border-gray-300 dark:border-gray-600" />
            </div>
            <div className="flex items-end gap-2">
              <button type="submit" className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700">Save</button>
              <button type="button" onClick={() => setShowForm(false)} className="px-4 py-2 border rounded hover:bg-gray-50 dark:hover:bg-gray-700">Cancel</button>
            </div>
          </div>
        </form>
      )}

      <div className="space-y-3">
        {rules.length === 0 ? (
          <div className="text-gray-500 text-center py-8">No alert rules configured</div>
        ) : (
          rules.map(rule => (
            <div key={rule.id} className="flex items-center justify-between p-4 bg-gray-50 dark:bg-gray-800 rounded-lg border">
              <div>
                <div className="font-medium">{rule.name}</div>
                <div className="text-sm text-gray-500">
                  When {rule.metric} {rule.condition} {rule.threshold} (cooldown: {rule.cooldown_seconds}s)
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => toggleRule(rule.id, !rule.enabled)} className={`px-3 py-1 text-sm rounded ${rule.enabled ? 'bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300' : 'bg-gray-200 dark:bg-gray-700'}`}>
                  {rule.enabled ? 'Enabled' : 'Disabled'}
                </button>
                <button onClick={() => deleteRule(rule.id)} className="px-3 py-1 text-sm text-red-600 hover:underline">Delete</button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}