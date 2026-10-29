'use client';

import type { PermissionGroup } from './data';

/**
 * Checklist of permission groups for a user or API key. The access level stays the base
 * (everything it holds by default); each group adds permissions on top of it.
 */
export function GroupPicker({
  groups, selected, onChange, disabled,
}: { groups: PermissionGroup[]; selected: string[]; onChange: (ids: string[]) => void; disabled?: boolean }) {
  if (groups.length === 0) {
    return <p className="text-xs text-muted-foreground">No permission groups yet. Create them under Settings → Permissions.</p>;
  }
  const toggle = (id: string) => onChange(selected.includes(id) ? selected.filter(s => s !== id) : [...selected, id]);
  return (
    <ul className="max-h-44 space-y-1 overflow-y-auto rounded-md border p-2" aria-label="Permission groups">
      {groups.map(g => (
        <li key={g.id}>
          <label className="flex cursor-pointer items-start gap-2 rounded px-1 py-1 text-sm hover:bg-muted/50">
            <input type="checkbox" className="mt-1" checked={selected.includes(g.id)} onChange={() => toggle(g.id)} disabled={disabled} />
            <span className="min-w-0">
              <span className="font-medium">{g.name}</span>
              <span className="ml-1 text-xs text-muted-foreground">{g.grants.length} permission{g.grants.length === 1 ? '' : 's'}</span>
              {g.description && <span className="block truncate text-xs text-muted-foreground">{g.description}</span>}
            </span>
          </label>
        </li>
      ))}
    </ul>
  );
}
