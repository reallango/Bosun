'use client';

import { useCallback, useEffect, useState } from 'react';
import Header from '@/components/layout/Header';
import { LoadingSpinner } from '@/components/shared/LoadingSpinner';
import { useToast } from '@/components/ui/toast';
import { accountApi, type Account } from '@/components/account/api';
import { ProfileCard, PasswordCard } from '@/components/account/ProfileCards';
import { MfaCard } from '@/components/account/MfaCard';

/** "My account": every signed-in user manages their own profile, password and two-step verification. */
export default function AccountPage() {
  const { toast } = useToast();
  const [account, setAccount] = useState<Account | null>(null);

  const load = useCallback(async () => {
    try {
      setAccount(await accountApi<Account>('/api/auth/account', 'GET'));
    } catch (err) {
      toast('Failed to load your account', { variant: 'error', description: err instanceof Error ? err.message : undefined });
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  return (
    <>
      <Header title="My Account" />
      <div className="page max-w-4xl space-y-4 sm:space-y-6">
        {!account ? (
          <LoadingSpinner />
        ) : (
          <>
            <ProfileCard account={account} onChange={setAccount} />
            <PasswordCard account={account} />
            <MfaCard account={account} reload={load} />
          </>
        )}
      </div>
    </>
  );
}
