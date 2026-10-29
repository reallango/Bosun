/**
 * The permission catalog: every action that can be granted separately.
 *
 * Reading stays level-based, as before: every signed-in user and API key has at
 * least Read only access, which already covers viewing servers, dashboards and
 * data. Permissions are for ACTIONS, and each one has a `defaultLevel`: the
 * built-in access levels grant exactly the permissions at or below their own
 * level (Read + actions = the operator ones, Full access = everything), so a
 * user who has only a level behaves exactly as before. Permission groups add
 * individual permissions on top of a level, optionally for one server or a
 * server group only.
 *
 * System widgets and core features are declared here. Widget packages will add
 * theirs to the database (`permission_definitions`) when installed; the readers
 * in `store.ts` merge the two lists, so nothing else has to change when a widget
 * is added.
 *
 * Pure (no imports of server code) so it can be used from the browser and tested.
 */

export type PermissionRisk = 'low' | 'medium' | 'high';

/** The legacy access level at which the built-in levels grant a permission (viewer = everyone). */
export type DefaultLevel = 'viewer' | 'operator' | 'admin';

export interface PermissionDef {
  /** Stable id, `<area>.<action>`, e.g. `power.restart`. */
  id: string;
  label: string;
  description: string;
  /** Heading in the permission editor. */
  group: string;
  defaultLevel: DefaultLevel;
  risk: PermissionRisk;
  /**
   * `server`: acts on one host, so it can be granted for all servers, one server or a
   * server group. `global`: not tied to a host; only grantable for everything.
   */
  scope: 'server' | 'global';
  /** Granting this also grants these. */
  implies?: string[];
  /** Where it comes from: `core`, `widget:<type>` or `package:<id>`. */
  source: string;
}

export const CATALOG: readonly PermissionDef[] = [
  // ---- Servers -----------------------------------------------------------
  { id: 'servers.view', label: 'See a server', group: 'Servers', source: 'core', defaultLevel: 'viewer', risk: 'low', scope: 'server',
    description: 'Everyone can see every server by default. Deny this in a permission group to hide a server (and its dashboards, widgets and data) from that group.' },
  { id: 'servers.refresh', label: 'Refresh a server now', group: 'Servers', source: 'core', defaultLevel: 'operator', risk: 'low', scope: 'server',
    description: 'Ask the poller to collect a server again immediately, instead of waiting for the next poll.' },

  // ---- Power -------------------------------------------------------------
  { id: 'power.wake', label: 'Wake a server', group: 'Power', source: 'core', defaultLevel: 'operator', risk: 'low', scope: 'server',
    description: 'Send a Wake-on-LAN packet to power a server on.' },
  { id: 'power.restart', label: 'Restart a server', group: 'Power', source: 'core', defaultLevel: 'operator', risk: 'high', scope: 'server',
    description: 'Restart the host over SSH. Running services and sessions are interrupted.' },
  { id: 'power.shutdown', label: 'Shut down a server', group: 'Power', source: 'core', defaultLevel: 'operator', risk: 'high', scope: 'server',
    description: 'Power the host off. It stays off until it is woken or started at the machine.' },

  // The permissions of the widgets (docker.*, ollama.*, updates.*, commands.run, ...) are provided by the bundled
  // widget packages in widgets/ and registered when they install.

  // ---- Shell (API) -------------------------------------------------------
  { id: 'shell.user', label: 'Terminal and commands as the non-admin account (API)', group: 'Shell', source: 'core', defaultLevel: 'admin', risk: 'high', scope: 'server',
    description: 'Run commands and open a terminal on the host as its unprivileged account (no sudo, no Docker group, no way back to the admin account). API keys only; the web terminal still asks for your own login.' },

  // ---- Dashboards --------------------------------------------------------
  { id: 'dashboards.edit', label: 'Edit dashboards', group: 'Dashboards', source: 'core', defaultLevel: 'operator', risk: 'low', scope: 'global',
    description: 'Create, rename and delete dashboards; add, move, resize, configure and remove widgets.' },
];

const BY_ID: ReadonlyMap<string, PermissionDef> = new Map(CATALOG.map(p => [p.id, p]));

export function permissionDef(id: string, extra: readonly PermissionDef[] = []): PermissionDef | undefined {
  return BY_ID.get(id) ?? extra.find(p => p.id === id);
}

/** The code catalog plus definitions registered by installed widget packages. */
export function fullCatalog(extra: readonly PermissionDef[] = []): PermissionDef[] {
  const seen = new Set(CATALOG.map(p => p.id));
  return [...CATALOG, ...extra.filter(p => !seen.has(p.id))];
}

/** Permissions a legacy access level holds by default. `admin` holds everything, including future ones. */
export function permissionsForLevel(level: string, extra: readonly PermissionDef[] = []): PermissionDef[] {
  const all = fullCatalog(extra);
  if (level === 'admin') return all;
  if (level === 'operator') return all.filter(p => p.defaultLevel === 'operator' || p.defaultLevel === 'viewer');
  if (level === 'viewer') return all.filter(p => p.defaultLevel === 'viewer');
  return [];
}

/** What `permission` includes: itself plus the permissions it implies (transitively). The reverse of `satisfiers`. */
export function impliedSet(permission: string, extra: readonly PermissionDef[] = []): Set<string> {
  const out = new Set<string>([permission]);
  const stack = [permission];
  while (stack.length) {
    const cur = permissionDef(stack.pop() as string, extra);
    for (const i of cur?.implies ?? []) {
      if (!out.has(i)) { out.add(i); stack.push(i); }
    }
  }
  return out;
}

/** Everything that satisfies `permission`: itself plus any permission that implies it (transitively). */
export function satisfiers(permission: string, extra: readonly PermissionDef[] = []): Set<string> {
  const all = fullCatalog(extra);
  const out = new Set<string>([permission]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of all) {
      if (!out.has(p.id) && (p.implies ?? []).some(i => out.has(i))) {
        out.add(p.id);
        grew = true;
      }
    }
  }
  return out;
}

export const RISK_LABEL: Record<PermissionRisk, string> = { low: 'Low', medium: 'Medium', high: 'High' };
