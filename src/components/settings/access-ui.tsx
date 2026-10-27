'use client';

import { ShieldAlert } from 'lucide-react';
import { ACCESS_LEVELS, ROLES, roleLabel } from '@/lib/auth/levels';
import { formatDistanceToNow } from '@/lib/utils/date';
import { cn } from '@/lib/utils';

/** SQLite "YYYY-MM-DD HH:MM:SS" (UTC) or ISO string to Date. */
export function parseWhen(value: string | null | undefined): Date | null {
  if (!value) return null;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(value) ? value.replace(' ', 'T') + 'Z' : value;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "3d ago" for past times, a date for future ones, a dash for none. */
export function When({ value, empty = '—' }: { value: string | null | undefined; empty?: string }) {
  const d = parseWhen(value);
  if (!d) return <span className="text-muted-foreground">{empty}</span>;
  const text = d.getTime() > Date.now() ? d.toLocaleDateString() : formatDistanceToNow(d);
  return <time dateTime={d.toISOString()} title={d.toLocaleString()}>{text}</time>;
}

const LEVEL_STYLE: Record<string, string> = {
  viewer: 'bg-muted text-foreground',
  operator: 'bg-blue-500/15 text-blue-700 dark:text-blue-300',
  admin: 'bg-amber-500/15 text-amber-800 dark:text-amber-300',
};

export function LevelBadge({ role }: { role: string }) {
  return (
    <span className={cn('inline-block whitespace-nowrap rounded px-2 py-0.5 text-xs font-medium', LEVEL_STYLE[role] ?? 'bg-muted')}>
      {roleLabel(role)}
    </span>
  );
}

/** Access level <select> with the level's description below it. */
export function LevelSelect({ id, value, onChange, disabled }: { id: string; value: string; onChange: (role: string) => void; disabled?: boolean }) {
  return (
    <div className="space-y-1.5">
      <select id={id} className="form-select" value={value} onChange={e => onChange(e.target.value)} disabled={disabled}>
        {ROLES.map(r => (
          <option key={r} value={r}>{ACCESS_LEVELS[r].level}. {ACCESS_LEVELS[r].label}</option>
        ))}
      </select>
      <p className="text-xs text-muted-foreground">{ACCESS_LEVELS[value as keyof typeof ACCESS_LEVELS]?.description}</p>
    </div>
  );
}

export function AdminOnlyNotice() {
  return (
    <div className="flex items-start gap-2 rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
      <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      This page needs Full access. Ask an admin if you need changes here.
    </div>
  );
}
