'use client';

import { useState } from 'react';
import { Power, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { useAuth } from '@/hooks/useAuth';
import { wakeServer, installWol, WakeError } from '@/lib/api/wake';
import { ConfirmActionDialog } from '@/components/widgets/shared/ConfirmActionDialog';

interface WakeButtonProps {
  serverId: string;
  serverName: string;
  /** undefined = unknown (the API reports a missing MAC); null/'' disables the button. */
  macAddress?: string | null;
  size?: 'sm' | 'default' | 'lg';
  variant?: 'outline' | 'ghost' | 'secondary';
  /** Icon-only button (the label goes to aria-label/title). */
  iconOnly?: boolean;
  className?: string;
}

/**
 * Sends a Wake-on-LAN magic packet for a server (operator+). When the
 * configured sending host lacks the `wakeonlan` utility, admins are offered
 * to install it there.
 */
export function WakeButton({ serverId, serverName, macAddress, size = 'sm', variant = 'outline', iconOnly, className }: WakeButtonProps) {
  const { toast } = useToast();
  const { user } = useAuth();
  const [waking, setWaking] = useState(false);
  const [installHost, setInstallHost] = useState<string | null>(null);
  const canWake = user?.role === 'admin' || user?.role === 'operator';
  if (!canWake) return null;

  const noMac = macAddress !== undefined && !macAddress;
  const label = noMac ? 'Add a MAC address to enable Wake-on-LAN' : `Wake ${serverName || 'server'}`;

  const wake = async () => {
    setWaking(true);
    try {
      const r = await wakeServer(serverId);
      const from = r.via === 'local_server' && r.host ? ` from ${r.host}` : '';
      toast(`Magic packet sent to ${serverName}`, {
        variant: 'success',
        description: `${r.mac} via ${r.broadcast}:${r.port}${from}. The host should power on shortly.`,
      });
    } catch (err) {
      if (err instanceof WakeError && err.needsInstall && user?.role === 'admin') {
        setInstallHost(err.host || 'the local server');
      } else {
        toast(`Could not wake ${serverName}`, { variant: 'error', description: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      setWaking(false);
    }
  };

  return (
    <>
      <Button
        type="button"
        size={iconOnly ? 'icon-sm' : size}
        variant={variant}
        onClick={wake}
        disabled={noMac || waking}
        title={label}
        aria-label={iconOnly ? label : undefined}
        className={className}
      >
        {waking ? <Loader2 className="animate-spin" aria-hidden /> : <Power aria-hidden />}
        {!iconOnly && (waking ? 'Waking…' : 'Wake')}
      </Button>
      <ConfirmActionDialog
        open={!!installHost}
        onOpenChange={o => { if (!o) setInstallHost(null); }}
        title={`Install wakeonlan on ${installHost}?`}
        description={<>The <code className="font-mono">wakeonlan</code> utility is missing on the host that sends Wake-on-LAN packets. Bosun can install it with the package manager (requires passwordless sudo for the SSH user).</>}
        confirmLabel="Install"
        onConfirm={async () => {
          const r = await installWol(serverId);
          toast(`wakeonlan installed on ${r.host}`, { variant: 'success', description: 'Try waking the server again.' });
        }}
      />
    </>
  );
}
