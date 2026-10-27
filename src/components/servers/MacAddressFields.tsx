'use client';

import { useEffect, useState } from 'react';
import { Wifi, Cable } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import { readJson } from '@/lib/api/readJson';

interface Nic { name: string; mac: string; wireless: boolean }
interface Nics { primary: Nic | null; alt: Nic | null; candidates: (Nic & { up: boolean; ipv4: string[] })[]; collectedAt?: string }

/** null = auto-detect (the poller fills it); '' = deliberately empty. */
export type MacValue = string | null;

interface Props {
  serverId?: string;
  mac: MacValue;
  macAlt: MacValue;
  onChange: (mac: MacValue, macAlt: MacValue) => void;
  idPrefix?: string;
}

const same = (a?: string | null, b?: string | null) => (a || '').toLowerCase().replace(/-/g, ':') === (b || '').toLowerCase().replace(/-/g, ':');

/**
 * Primary and alternate Wake-on-LAN MAC fields. Both are filled automatically
 * from the host's NICs (primary = the NIC Bosun reaches it through, alternate =
 * its wired/wireless counterpart), so they only need editing when detection is
 * wrong or the hardware changed; the detected values are shown for one-click use.
 */
export function MacAddressFields({ serverId, mac, macAlt, onChange, idPrefix = 'mac' }: Props) {
  const [nics, setNics] = useState<Nics | null>(null);

  useEffect(() => {
    if (!serverId) return;
    fetchWithAuth(`/api/servers/${serverId}/nics`)
      .then(r => readJson<{ data?: Nics | null }>(r))
      .then(j => setNics(j.data || null))
      .catch(() => setNics(null));
  }, [serverId]);

  const field = (label: string, value: MacValue, detected: Nic | null | undefined, set: (v: MacValue) => void, id: string) => (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} value={value ?? ''} placeholder={value === null ? 'Detected automatically' : 'AA:BB:CC:DD:EE:FF'} className="font-mono"
        onChange={e => set(e.target.value)} />
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        {detected ? (
          <>
            <span className="inline-flex items-center gap-1">
              {detected.wireless ? <Wifi className="size-3" aria-hidden /> : <Cable className="size-3" aria-hidden />}
              Host reports {detected.name}: <code className="font-mono">{detected.mac}</code>
            </span>
            {!same(detected.mac, value) && (
              <button type="button" className="text-primary hover:underline" onClick={() => set(detected.mac)}>
                {value ? 'differs, use detected' : 'use'}
              </button>
            )}
          </>
        ) : (
          <span>{serverId ? 'Nothing detected yet' : 'Detected on the first poll after adding'}</span>
        )}
        {value !== null && (
          <button type="button" className="text-primary hover:underline" onClick={() => set(null)} title="Clear and let Bosun fill it from the host">
            auto-detect
          </button>
        )}
      </div>
    </div>
  );

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      {field('Wake-on-LAN MAC', mac, nics?.primary, v => onChange(v, macAlt), `${idPrefix}-primary`)}
      {field('Alternate MAC (wired/wireless)', macAlt, nics?.alt, v => onChange(mac, v), `${idPrefix}-alt`)}
    </div>
  );
}
