/**
 * Widget packages shipped inside the image (`widgets/` next to the app) and installed by default.
 * `widgets/bundled.json` lists the package ids that are installed automatically; the rest of the
 * folder is only the catalog that GitHub listings use. A bundled package the admin removed stays
 * removed (its id is kept in app_config) until it is installed again by hand.
 */
import fs from 'fs';
import path from 'path';
import { getConfig, setConfig } from '@/lib/db/migrations';
import { validateFiles, validateManifest, type PackageManifest, type PackageFiles } from '@/lib/widgets/package-manifest';
import { reservedPackageNames } from '@/lib/widgets/system-packages';

const REMOVED_KEY = 'widgets.bundled_removed';

export function widgetsDir(): string {
  return path.join(process.cwd(), 'widgets');
}

/** Package ids listed in widgets/bundled.json (empty when the file is missing or unreadable). */
export function bundledIds(dir = widgetsDir()): string[] {
  try {
    const list = JSON.parse(fs.readFileSync(path.join(dir, 'bundled.json'), 'utf8'));
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** Every package folder of the image (the catalog), bundled or not. */
export function catalogIds(dir = widgetsDir()): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('_')).map(e => e.name);
  } catch {
    return [];
  }
}

export function isBundledId(id: string): boolean {
  return bundledIds().includes(id);
}

function readFilesRecursive(root: string, rel = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) Object.assign(out, readFilesRecursive(root, r));
    else if (r !== 'manifest.json') out[r] = fs.readFileSync(path.join(root, r), 'utf8');
  }
  return out;
}

export interface BundledPackage {
  manifest: PackageManifest;
  files: PackageFiles;
}

/** Read and validate the bundled packages; invalid ones are reported and skipped. */
export function readBundledPackages(dir = widgetsDir(), only: string[] = bundledIds(dir)): { packages: BundledPackage[]; errors: string[] } {
  const packages: BundledPackage[] = [];
  const errors: string[] = [];
  const { types, ids } = reservedPackageNames();
  for (const id of only) {
    try {
      const folder = path.join(dir, id);
      const raw = JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json'), 'utf8'));
      const m = validateManifest(raw, { reservedTypes: types, reservedIds: ids });
      if (!m.ok) { errors.push(`${id}: ${m.error}`); continue; }
      if (m.value.id !== id) { errors.push(`${id}: the manifest id is "${m.value.id}"`); continue; }
      const f = validateFiles(readFilesRecursive(folder));
      if (!f.ok) { errors.push(`${id}: ${f.error}`); continue; }
      packages.push({ manifest: m.value, files: f.value });
    } catch (err) {
      errors.push(`${id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { packages, errors };
}

export async function removedBundledIds(): Promise<string[]> {
  try {
    const list = JSON.parse((await getConfig(REMOVED_KEY)) || '[]');
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export async function markBundledRemoved(id: string): Promise<void> {
  const list = await removedBundledIds();
  if (!list.includes(id)) await setConfig(REMOVED_KEY, JSON.stringify([...list, id]));
}

export async function unmarkBundledRemoved(id: string): Promise<void> {
  const list = await removedBundledIds();
  if (list.includes(id)) await setConfig(REMOVED_KEY, JSON.stringify(list.filter(x => x !== id)));
}
