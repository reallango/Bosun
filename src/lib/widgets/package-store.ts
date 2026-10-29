/**
 * Database side of widget packages: install, upgrade, remove and list. Everything that changes
 * several tables runs in one rqlite transaction (the schema does not rely on foreign keys).
 *
 *  - widget_packages      one row per installed package (manifest + extra files)
 *  - custom_widgets       its widget types (package_id set); `enabled` is the admin's choice and survives upgrades
 *  - permission_definitions  the permissions it introduces (source `package:<id>`)
 */
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';
import { invalidatePermissionCache } from '@/lib/permissions/store';
import { compareVersions, validateManifest, manifestToJson, type PackageManifest, type PackageFiles } from '@/lib/widgets/package-manifest';
import { reservedPackageNames } from '@/lib/widgets/system-packages';

export class PackageError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 400, code = 'PACKAGE_ERROR') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface InstalledPackage {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  source: 'github' | 'upload';
  sourceRef: string | null;
  installedAt: string;
  updatedAt: string;
  widgetTypes: string[];
  permissions: string[];
  manifest: PackageManifest;
}

function toInstalled(row: Record<string, unknown>): InstalledPackage | null {
  let raw: unknown;
  try { raw = JSON.parse(String(row.manifest)); } catch { return null; }
  const { types, ids } = reservedPackageNames();
  // Stored manifests were validated on the way in; re-parsing keeps the shape typed.
  const v = validateManifest(raw, { reservedTypes: types, reservedIds: ids });
  if (!v.ok) return null;
  return {
    id: String(row.id), name: String(row.name), version: String(row.version), description: String(row.description ?? ''),
    author: String(row.author ?? ''), source: row.source === 'github' ? 'github' : 'upload', sourceRef: row.source_ref ? String(row.source_ref) : null,
    installedAt: String(row.installed_at), updatedAt: String(row.updated_at),
    widgetTypes: v.value.widgets.map(w => w.type), permissions: v.value.permissions.map(p => p.id), manifest: v.value,
  };
}

export async function listInstalledPackages(): Promise<InstalledPackage[]> {
  const r = await rqlite.query('SELECT * FROM widget_packages ORDER BY name');
  return rowsToObjects(r).map(toInstalled).filter((p): p is InstalledPackage => p !== null);
}

export async function getInstalledPackage(id: string): Promise<{ pkg: InstalledPackage; files: PackageFiles } | null> {
  const r = await rqlite.query('SELECT * FROM widget_packages WHERE id = ?', [id]);
  const row = rowsToObjects(r)[0];
  if (!row) return null;
  const pkg = toInstalled(row);
  if (!pkg) return null;
  let files: PackageFiles = {};
  try { files = JSON.parse(String(row.files || '{}')); } catch { files = {}; }
  return { pkg, files };
}

const placeholders = (n: number) => Array.from({ length: n }, () => '?').join(',');

async function instanceCount(types: string[]): Promise<number> {
  if (!types.length) return 0;
  const r = await rqlite.query(`SELECT COUNT(*) FROM widgets WHERE widget_type IN (${placeholders(types.length)})`, types);
  return Number(r.values?.[0]?.[0] ?? 0);
}

export interface InstallOptions {
  manifest: PackageManifest;
  files: PackageFiles;
  source: 'github' | 'upload';
  sourceRef?: string | null;
  userId?: string | null;
  /** Allow replacing an installed package with an older or equal version (re-import). Off by default. */
  allowSameOrOlder?: boolean;
}

export interface InstallResult {
  id: string;
  version: string;
  previousVersion: string | null;
  widgetTypes: string[];
  permissions: string[];
}

/** Install a validated package, or upgrade the installed one. */
export async function installPackage(opts: InstallOptions): Promise<InstallResult> {
  const { manifest, files } = opts;
  const { ids, types } = reservedPackageNames();
  if (ids.includes(manifest.id) || manifest.widgets.some(w => types.includes(w.type))) {
    throw new PackageError('That package would replace a system widget, which is not allowed', 409, 'SYSTEM_PACKAGE');
  }
  const existing = await getInstalledPackage(manifest.id);
  const previousVersion = existing?.pkg.version ?? null;
  if (existing && !opts.allowSameOrOlder && compareVersions(manifest.version, existing.pkg.version) <= 0) {
    throw new PackageError(`Version ${existing.pkg.version} is already installed (this is ${manifest.version})`, 409, 'NOT_NEWER');
  }

  // Widget types may not collide with ones the admin created by hand or with another package.
  const newTypes = manifest.widgets.map(w => w.type);
  const clash = await rqlite.query(
    `SELECT type, package_id FROM custom_widgets WHERE type IN (${placeholders(newTypes.length)})`, newTypes);
  for (const row of rowsToObjects(clash)) {
    if (row.package_id !== manifest.id) throw new PackageError(`Widget type "${row.type}" already exists`, 409, 'TYPE_EXISTS');
  }
  // Permissions may not collide with another package's.
  if (manifest.permissions.length) {
    const pc = await rqlite.query(
      `SELECT id, source FROM permission_definitions WHERE id IN (${placeholders(manifest.permissions.length)})`, manifest.permissions.map(p => p.id));
    for (const row of rowsToObjects(pc)) {
      if (row.source !== `package:${manifest.id}`) throw new PackageError(`Permission "${row.id}" already exists`, 409, 'PERMISSION_EXISTS');
    }
  }

  // An upgrade that drops a widget type is refused while that type is on a dashboard.
  const dropped = existing ? existing.pkg.widgetTypes.filter(t => !newTypes.includes(t)) : [];
  if (dropped.length && (await instanceCount(dropped)) > 0) {
    throw new PackageError(`This version no longer provides ${dropped.join(', ')}, which is used on a dashboard. Remove those widgets first.`, 409, 'TYPE_IN_USE');
  }

  const source = `package:${manifest.id}`;
  const stmts: { sql: string; params?: unknown[] }[] = [];
  stmts.push({
    sql: `INSERT INTO widget_packages (id, name, version, description, author, source, source_ref, manifest, files, installed_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET name = excluded.name, version = excluded.version, description = excluded.description,
            author = excluded.author, source = excluded.source, source_ref = excluded.source_ref, manifest = excluded.manifest,
            files = excluded.files, updated_at = CURRENT_TIMESTAMP`,
    params: [manifest.id, manifest.name, manifest.version, manifest.description, manifest.author, opts.source, opts.sourceRef ?? null,
      JSON.stringify(manifestToJson(manifest)), JSON.stringify(files), opts.userId ?? null],
  });
  for (const w of manifest.widgets) {
    const c = w.columns;
    stmts.push({
      sql: `INSERT INTO custom_widgets (id, type, display_name, description, icon, category, default_size, min_size, refresh_interval,
              supports_linux, supports_windows, config_schema, enabled, builtin, package_id, spec)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)
            ON CONFLICT(type) DO UPDATE SET display_name = excluded.display_name, description = excluded.description, icon = excluded.icon,
              category = excluded.category, default_size = excluded.default_size, min_size = excluded.min_size,
              refresh_interval = excluded.refresh_interval, supports_linux = excluded.supports_linux,
              supports_windows = excluded.supports_windows, config_schema = excluded.config_schema,
              package_id = excluded.package_id, spec = excluded.spec, updated_at = CURRENT_TIMESTAMP`,
      params: [`pkg-${manifest.id}-${w.type}`, w.type, c.display_name, c.description ?? '', c.icon ?? 'puzzle', c.category ?? 'custom',
        c.default_size ?? '{"w":8,"h":6}', c.min_size ?? '{"w":4,"h":4}', c.refresh_interval ?? 30,
        c.supports_linux ?? 1, c.supports_windows ?? 1, c.config_schema ?? '[]', manifest.id, w.spec ? JSON.stringify(w.spec) : null],
    });
  }
  for (const t of dropped) stmts.push({ sql: 'DELETE FROM custom_widgets WHERE type = ? AND package_id = ?', params: [t, manifest.id] });

  // Permissions: drop the ones this version no longer declares (and any grants of them), upsert the rest.
  const permIds = manifest.permissions.map(p => p.id);
  stmts.push({
    sql: `DELETE FROM permission_grants WHERE permission IN (SELECT id FROM permission_definitions WHERE source = ?${permIds.length ? ` AND id NOT IN (${placeholders(permIds.length)})` : ''})`,
    params: [source, ...permIds],
  });
  stmts.push({
    sql: `DELETE FROM permission_definitions WHERE source = ?${permIds.length ? ` AND id NOT IN (${placeholders(permIds.length)})` : ''}`,
    params: [source, ...permIds],
  });
  for (const p of manifest.permissions) {
    stmts.push({
      sql: `INSERT INTO permission_definitions (id, source, label, description, group_name, default_level, risk, scope, implies)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET label = excluded.label, description = excluded.description, group_name = excluded.group_name,
              default_level = excluded.default_level, risk = excluded.risk, scope = excluded.scope, implies = excluded.implies`,
      params: [p.id, source, p.label, p.description, p.group, p.defaultLevel, p.risk, p.scope, JSON.stringify(p.implies)],
    });
  }

  await rqlite.executeBatch(stmts as { sql: string; params?: never[] }[], { transaction: true });
  invalidatePermissionCache();
  return { id: manifest.id, version: manifest.version, previousVersion, widgetTypes: newTypes, permissions: permIds };
}

export async function removePackage(id: string, removeWidgets: boolean): Promise<{ removedWidgets: number }> {
  const found = await getInstalledPackage(id);
  if (!found) throw new PackageError('Package not found', 404, 'NOT_FOUND');
  const inUse = await instanceCount(found.pkg.widgetTypes);
  if (inUse > 0 && !removeWidgets) {
    throw new PackageError(`${inUse} widget${inUse === 1 ? ' is' : 's are'} using this package. Remove them first, or remove the package together with its widgets.`, 409, 'IN_USE');
  }
  const stmts: { sql: string; params?: unknown[] }[] = [];
  const types = found.pkg.widgetTypes;
  if (types.length) stmts.push({ sql: `DELETE FROM widgets WHERE widget_type IN (${placeholders(types.length)})`, params: types });
  stmts.push({ sql: 'DELETE FROM permission_grants WHERE permission IN (SELECT id FROM permission_definitions WHERE source = ?)', params: [`package:${id}`] });
  stmts.push({ sql: 'DELETE FROM permission_definitions WHERE source = ?', params: [`package:${id}`] });
  stmts.push({ sql: 'DELETE FROM custom_widgets WHERE package_id = ?', params: [id] });
  stmts.push({ sql: 'DELETE FROM widget_packages WHERE id = ?', params: [id] });
  await rqlite.executeBatch(stmts as { sql: string; params?: never[] }[], { transaction: true });
  invalidatePermissionCache();
  return { removedWidgets: inUse };
}
