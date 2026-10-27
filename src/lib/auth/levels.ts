/**
 * Access levels. The stored role values stay `viewer` / `operator` / `admin`;
 * this module gives them their user-facing names and ordering. Safe to import
 * from client components (no server-only imports).
 */

export type Role = 'viewer' | 'operator' | 'admin';

/** Lowest to highest. */
export const ROLES: readonly Role[] = ['viewer', 'operator', 'admin'] as const;

const RANK: Record<Role, number> = { viewer: 1, operator: 2, admin: 3 };

export interface AccessLevel {
  role: Role;
  /** 1, 2 or 3. */
  level: number;
  label: string;
  description: string;
}

export const ACCESS_LEVELS: Record<Role, AccessLevel> = {
  viewer: {
    role: 'viewer',
    level: 1,
    label: 'Read only',
    description: 'View dashboards, statistics, live widget data and server/cluster status.',
  },
  operator: {
    role: 'operator',
    level: 2,
    label: 'Read + actions',
    description:
      'Read only, plus widget actions: start/stop/restart containers and view their logs, pull/delete Ollama models, ' +
      'install OS updates, Wake-on-LAN, restart or shut down servers, force refreshes, and editing dashboards and widgets. No shells or arbitrary commands.',
  },
  admin: {
    role: 'admin',
    level: 3,
    label: 'Full access',
    description: 'Everything: servers, SSH keys, terminals and commands, settings, cluster, users and API keys.',
  },
};

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(RANK, value);
}

/** 0 for unknown values. */
export function roleRank(role: unknown): number {
  return isRole(role) ? RANK[role] : 0;
}

/** Does `role` grant at least `required`? Unknown roles grant nothing. */
export function hasRole(role: unknown, required: Role): boolean {
  return roleRank(role) >= RANK[required];
}

/** "Read only" / "Read + actions" / "Full access"; the raw value for unknown roles. */
export function roleLabel(role: unknown): string {
  return isRole(role) ? ACCESS_LEVELS[role].label : String(role ?? '');
}

export function roleDescription(role: unknown): string {
  return isRole(role) ? ACCESS_LEVELS[role].description : '';
}

/** The lower of two roles (e.g. an API key's level capped by policy). */
export function minRole(a: Role, b: Role): Role {
  return RANK[a] <= RANK[b] ? a : b;
}
