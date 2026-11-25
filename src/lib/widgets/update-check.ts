/**
 * Widget package updates in the notification bell.
 *
 * - Every few hours the cluster leader compares the installed packages with the configured branch of the
 *   Bosun repository and raises one "update available" notice per package and version.
 * - Installing a newer version (by hand, or a bundled package upgraded with a new Bosun image) raises an
 *   "upgraded" notice and resolves that package's open "update available" notices.
 */
import { compareVersions } from '@/lib/widgets/package-manifest';
import { notify, resolveByKeyPrefix } from '@/lib/notifications/store';
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_MS = 2 * 60 * 1000;
const LINK = '/settings/widgets';

export interface InstalledVersion { id: string; name: string; version: string }
export interface RemoteVersion { id: string; name: string; version: string }
export interface PendingUpdate { id: string; name: string; installed: string; available: string }

/** Installed packages for which the remote listing has a newer version. Pure. */
export function pendingUpdates(installed: InstalledVersion[], remote: RemoteVersion[]): PendingUpdate[] {
  const byId = new Map(remote.map(r => [r.id, r]));
  const out: PendingUpdate[] = [];
  for (const p of installed) {
    const r = byId.get(p.id);
    if (r && compareVersions(r.version, p.version) > 0) out.push({ id: p.id, name: r.name || p.name, installed: p.version, available: r.version });
  }
  return out;
}

export const updateKeyPrefix = (id: string) => `widget-update:${id}:`;

/** Raise "update available" notices (once per package and version). Returns how many were new. */
export async function announceUpdates(updates: PendingUpdate[], ref: string): Promise<number> {
  let raised = 0;
  for (const u of updates) {
    const fresh = await notify({
      kind: 'widget_update', severity: 'info', audience: 'admin', link: LINK,
      dedupeKey: `${updateKeyPrefix(u.id)}${u.available}`,
      title: `Widget update: ${u.name} ${u.available}`,
      message: `${u.name} ${u.installed} → ${u.available} is available from the ${ref} branch. Upgrade it under Settings → Widgets.`,
      data: { package: u.id, installed: u.installed, available: u.available, ref },
    });
    if (fresh) raised++;
  }
  return raised;
}

/** After an install or upgrade: say so, and close the package's open "update available" notices. Never throws. */
export async function announceInstalled(opts: {
  id: string; name: string; version: string; previousVersion: string | null;
  source: 'github' | 'upload' | 'bundled'; userId?: string | null;
}): Promise<void> {
  const { id, name, version, previousVersion, source } = opts;
  if (previousVersion === version) return;
  // A fresh image installs every bundled package on first start; that is not news.
  if (!previousVersion && source === 'bundled') return;
  await resolveByKeyPrefix(updateKeyPrefix(id));
  const who = source === 'bundled' ? 'automatically, with this version of Bosun' : `by ${await userName(opts.userId)}`;
  const from = source === 'github' ? ' from GitHub' : source === 'upload' ? ' from an uploaded file' : '';
  const verb = !previousVersion ? 'installed' : compareVersions(version, previousVersion) > 0 ? 'upgraded to' : 'replaced with';
  await notify({
    kind: 'widget_upgraded', severity: 'success', audience: 'admin', link: LINK,
    dedupeKey: `widget-installed:${id}:${version}:${Date.now()}`,
    title: previousVersion ? `${name} ${verb} ${version}` : `${name} ${version} installed`,
    message: previousVersion ? `${name} ${previousVersion} → ${version}${from}, ${who}.` : `${name} ${version} was installed${from}, ${who}.`,
    data: { package: id, previous: previousVersion, version, source },
  });
}

async function userName(userId: string | null | undefined): Promise<string> {
  if (!userId) return 'an administrator';
  try {
    const r = rowsToObjects(await rqlite.query('SELECT username FROM users WHERE id = ?', [userId]));
    return r[0]?.username ? String(r[0].username) : 'an administrator';
  } catch {
    return 'an administrator';
  }
}

async function isLeader(): Promise<boolean> {
  try {
    const s = await rqlite.getStatus();
    return s?.store?.raft?.state === 'Leader';
  } catch {
    return false;
  }
}

/** One check: leader only, and only when packages are listed from GitHub. Never throws. */
export async function checkWidgetUpdates(): Promise<number> {
  try {
    if (!(await isLeader())) return 0;
    const [{ configuredRef }, { listRemotePackagesCached }, { listInstalledPackages }] = await Promise.all([
      import('@/lib/widgets/package-routes'), import('@/lib/widgets/package-source'), import('@/lib/widgets/package-store'),
    ]);
    const ref = await configuredRef();
    const listing = await listRemotePackagesCached(ref, true);
    const installed = (await listInstalledPackages()).map(p => ({ id: p.id, name: p.name, version: p.version }));
    const remote = listing.packages.map(p => ({ id: p.id, name: p.manifest.name, version: p.manifest.version }));
    const n = await announceUpdates(pendingUpdates(installed, remote), ref);
    if (n) console.log(`[widgets] ${n} widget update${n === 1 ? '' : 's'} available`);
    return n;
  } catch (err) {
    console.warn(`[widgets] update check failed: ${err instanceof Error ? err.message : err}`);
    return 0;
  }
}

const g = globalThis as unknown as { __bosunWidgetUpdateCheck?: NodeJS.Timeout };

/** Check a little after start and then every few hours, once per process. */
export function startWidgetUpdateCheck(): void {
  if (g.__bosunWidgetUpdateCheck || process.env.BOSUN_WIDGET_UPDATE_CHECK === '0') return;
  const first = setTimeout(() => { void checkWidgetUpdates(); }, FIRST_CHECK_MS);
  first.unref?.();
  g.__bosunWidgetUpdateCheck = setInterval(() => { void checkWidgetUpdates(); }, CHECK_EVERY_MS);
  g.__bosunWidgetUpdateCheck.unref?.();
}
