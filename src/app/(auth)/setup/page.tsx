'use client';

import { useState } from 'react';
import SetupForm from '@/components/settings/SetupForm';
import JoinClusterForm from '@/components/settings/JoinClusterForm';
import { AuthBrand } from '@/components/settings/AuthBrand';
import { cn } from '@/lib/utils';

export default function SetupPage() {
  const [mode, setMode] = useState<'new' | 'join'>('new');
  const tab = (m: typeof mode, label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={mode === m}
      onClick={() => setMode(m)}
      className={cn('flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
        mode === m ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground')}
    >
      {label}
    </button>
  );
  return (
    <>
      <AuthBrand subtitle="Initial Setup" />
      <div role="tablist" className="mb-4 flex gap-1 rounded-lg bg-muted p-1">
        {tab('new', 'New installation')}
        {tab('join', 'Join an existing cluster')}
      </div>
      {mode === 'new' ? <SetupForm /> : <JoinClusterForm />}
    </>
  );
}
