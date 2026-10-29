/**
 * Where widget packages are listed from: the `widgets/` folder of the Bosun repository on GitHub,
 * on the branch chosen in the settings (`main` by default, or `dev`). Only the fixed repository
 * is ever contacted; the branch is limited to ALLOWED_REFS, and every package is validated
 * exactly like an uploaded one before it is offered or installed.
 */
import { validateManifest, validateFiles, MAX_FILES, type PackageManifest, type PackageFiles } from '@/lib/widgets/package-manifest';
import { reservedPackageNames } from '@/lib/widgets/system-packages';

export const SOURCE_REPO = 'reallango/Bosun';
export const ALLOWED_REFS = ['main', 'dev'] as const;
export type SourceRef = (typeof ALLOWED_REFS)[number];
export const DEFAULT_REF: SourceRef = 'main';

const MAX_PACKAGES = 100;
const MAX_RESPONSE_BYTES = 512 * 1024;
const TIMEOUT_MS = 10_000;

type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean; status: number; headers: { get(name: string): string | null }; text(): Promise<string>;
}>;

export interface RemoteEntry {
  id: string;
  manifest: PackageManifest;
}

export interface RemoteListing {
  ref: SourceRef;
  packages: RemoteEntry[];
  /** Folders that were skipped, with the reason (invalid manifest, wrong id, ...). */
  skipped: { dir: string; error: string }[];
}

export class SourceError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

export function isAllowedRef(v: unknown): v is SourceRef {
  return typeof v === 'string' && (ALLOWED_REFS as readonly string[]).includes(v);
}

async function getText(f: FetchLike, url: string): Promise<string> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await f(url, { headers: { 'User-Agent': 'bosun-widget-packages', Accept: 'application/vnd.github+json' }, signal: ctl.signal });
    if (!res.ok) {
      if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') throw new SourceError('GitHub rate limit reached; try again later', 429);
      throw new SourceError(res.status === 404 ? 'Not found on GitHub (is the folder on this branch?)' : `GitHub answered ${res.status}`, res.status === 404 ? 404 : 502);
    }
    const text = await res.text();
    if (text.length > MAX_RESPONSE_BYTES) throw new SourceError('GitHub response is too large');
    return text;
  } catch (err) {
    if (err instanceof SourceError) throw err;
    throw new SourceError(`Could not reach GitHub: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(t);
  }
}

const apiUrl = (ref: string, path: string) => `https://api.github.com/repos/${SOURCE_REPO}/contents/${path}?ref=${encodeURIComponent(ref)}`;
const rawUrl = (ref: string, path: string) => `https://raw.githubusercontent.com/${SOURCE_REPO}/${encodeURIComponent(ref)}/${path}`;

interface DirEntry { name: string; type: string; path: string }

async function listDir(f: FetchLike, ref: string, path: string): Promise<DirEntry[]> {
  let json: unknown;
  try { json = JSON.parse(await getText(f, apiUrl(ref, path))); } catch (err) {
    if (err instanceof SourceError) throw err;
    throw new SourceError('GitHub returned something unexpected');
  }
  if (!Array.isArray(json)) throw new SourceError('GitHub returned something unexpected');
  return json
    .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
    .map(e => ({ name: String(e.name), type: String(e.type), path: String(e.path) }));
}

function parseManifest(text: string, dir: string): { ok: true; manifest: PackageManifest } | { ok: false; error: string } {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { ok: false, error: 'manifest.json is not valid JSON' }; }
  const { types, ids } = reservedPackageNames();
  const v = validateManifest(raw, { reservedTypes: types, reservedIds: ids });
  if (!v.ok) return { ok: false, error: v.error };
  if (v.value.id !== dir) return { ok: false, error: `the manifest id "${v.value.id}" must match its folder name "${dir}"` };
  return { ok: true, manifest: v.value };
}

/** The valid packages in `widgets/` on a branch. Invalid ones are reported in `skipped`, not offered. */
export async function listRemotePackages(ref: SourceRef, f: FetchLike = fetch as unknown as FetchLike): Promise<RemoteListing> {
  let entries: DirEntry[];
  try {
    entries = await listDir(f, ref, 'widgets');
  } catch (err) {
    // No widgets/ folder on this branch yet is an empty list, not an error.
    if (err instanceof SourceError && err.status === 404) return { ref, packages: [], skipped: [] };
    throw err;
  }
  const dirs = entries.filter(e => e.type === 'dir' && /^[a-z][a-z0-9_]{1,39}$/.test(e.name)).slice(0, MAX_PACKAGES);
  const packages: RemoteEntry[] = [];
  const skipped: { dir: string; error: string }[] = [];
  await Promise.all(dirs.map(async d => {
    try {
      const parsed = parseManifest(await getText(f, rawUrl(ref, `widgets/${d.name}/manifest.json`)), d.name);
      if (parsed.ok) packages.push({ id: d.name, manifest: parsed.manifest });
      else skipped.push({ dir: d.name, error: parsed.error });
    } catch (err) {
      skipped.push({ dir: d.name, error: err instanceof Error ? err.message : String(err) });
    }
  }));
  packages.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
  return { ref, packages, skipped };
}

/** Download one package (manifest and its text files) from a branch, validated. */
export async function fetchRemotePackage(
  ref: SourceRef, id: string, f: FetchLike = fetch as unknown as FetchLike,
): Promise<{ manifest: PackageManifest; files: PackageFiles }> {
  if (!/^[a-z][a-z0-9_]{1,39}$/.test(id)) throw new SourceError('Invalid package id', 400);
  const base = `widgets/${id}`;
  const parsed = parseManifest(await getText(f, rawUrl(ref, `${base}/manifest.json`)), id);
  if (!parsed.ok) throw new SourceError(`Package "${id}" is not valid: ${parsed.error}`, 422);

  // Other files in the folder (at most two levels deep), text only.
  const found: string[] = [];
  const walk = async (path: string, depth: number) => {
    for (const e of await listDir(f, ref, path)) {
      if (e.type === 'dir' && depth < 2) await walk(e.path, depth + 1);
      else if (e.type === 'file') found.push(e.path.slice(base.length + 1));
      if (found.length > MAX_FILES + 1) throw new SourceError('Package has too many files', 422);
    }
  };
  await walk(base, 0);
  const files: Record<string, string> = {};
  for (const rel of found.filter(p => p !== 'manifest.json')) {
    files[rel] = await getText(f, rawUrl(ref, `${base}/${rel}`));
  }
  const checked = validateFiles(files);
  if (!checked.ok) throw new SourceError(`Package "${id}" is not valid: ${checked.error}`, 422);
  return { manifest: parsed.manifest, files: checked.value };
}

/** Short in-memory cache so the page does not spend the (unauthenticated) GitHub rate limit on every visit. */
const LISTING_TTL_MS = 5 * 60 * 1000;
const g = globalThis as unknown as { __bosunPkgListing?: Map<string, { at: number; listing: RemoteListing }> };
const listingCache = g.__bosunPkgListing ?? (g.__bosunPkgListing = new Map());

export async function listRemotePackagesCached(ref: SourceRef, force = false): Promise<RemoteListing> {
  const hit = listingCache.get(ref);
  if (!force && hit && Date.now() - hit.at < LISTING_TTL_MS) return hit.listing;
  const listing = await listRemotePackages(ref);
  listingCache.set(ref, { at: Date.now(), listing });
  return listing;
}
