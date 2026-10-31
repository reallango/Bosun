/**
 * Keeps this node's folder of widget packages in step with the database (see materialize.ts for the layout).
 *
 * The check that runs every few seconds reads only `id` and `content_hash` of every package: when nothing changed
 * (nearly always) that is one small query and no file access beyond reading the `CURRENT` markers. Only a package
 * whose hash differs from the copy on disk is loaded in full and written.
 */
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';
import {
  contentHashOf, hash16, materializePackage, materializedIds, plan, removeMaterialized, readMaterializedFile, widgetFilesRoot, type PackageFiles,
} from '@/lib/widgets/materialize';

export interface SyncSummary {
  written: string[];
  removed: string[];
  failed: { id: string; error: string }[];
}

interface Row { id: string; version: string; manifest: string; files: PackageFiles; contentHash: string | null }

function parseFiles(raw: unknown): PackageFiles {
  try {
    const v = JSON.parse(String(raw || '{}'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}

async function loadRow(id: string): Promise<Row | null> {
  const r = rowsToObjects(await rqlite.query('SELECT id, version, manifest, files, content_hash FROM widget_packages WHERE id = ?', [id]))[0];
  if (!r) return null;
  return { id: String(r.id), version: String(r.version), manifest: String(r.manifest), files: parseFiles(r.files), contentHash: r.content_hash ? String(r.content_hash) : null };
}

/** Give packages from before the hash existed their hash (every node computes the same value, so races are harmless). */
async function backfillHashes(): Promise<void> {
  const missing = await rqlite.query('SELECT id FROM widget_packages WHERE content_hash IS NULL');
  for (const [id] of missing.values ?? []) {
    const row = await loadRow(String(id));
    if (!row) continue;
    await rqlite.execute('UPDATE widget_packages SET content_hash = ? WHERE id = ? AND content_hash IS NULL', [contentHashOf(row.manifest, row.files), row.id]).catch(() => undefined);
  }
}

/** Bring the folder in line with the database. Never throws; a package that cannot be written is reported. */
export async function syncPackageFiles(root = widgetFilesRoot()): Promise<SyncSummary> {
  const out: SyncSummary = { written: [], removed: [], failed: [] };
  try { await backfillHashes(); } catch { /* read-only start: try again next time */ }
  const list = await rqlite.query('SELECT id, content_hash FROM widget_packages WHERE content_hash IS NOT NULL');
  const rows = (list.values ?? []).map(v => ({ id: String(v[0]), contentHash: String(v[1]) }));
  const { write, remove } = plan(root, rows);
  for (const id of write) {
    try {
      const row = await loadRow(id);
      if (!row) continue;
      materializePackage(root, { id: row.id, version: row.version, manifest: row.manifest, files: row.files, contentHash: row.contentHash });
      out.written.push(id);
    } catch (err) {
      out.failed.push({ id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  for (const id of remove) if (removeMaterialized(root, id)) out.removed.push(id);
  return out;
}

/** Write one package now (after an install or upgrade on this node, so it need not wait for the next check). */
export async function materializeNow(id: string, root = widgetFilesRoot()): Promise<void> {
  const row = await loadRow(id);
  if (!row) { removeMaterialized(root, id); return; }
  materializePackage(root, { id: row.id, version: row.version, manifest: row.manifest, files: row.files, contentHash: row.contentHash ?? undefined });
}

/**
 * A file of a package: from this node's folder when it holds the current copy, otherwise straight from the database
 * (a node that is behind, or has just started, still serves the right content).
 */
export async function getPackageFile(id: string, name: string, root = widgetFilesRoot()): Promise<string | null> {
  const r = rowsToObjects(await rqlite.query('SELECT content_hash FROM widget_packages WHERE id = ?', [id]))[0];
  if (!r) return null;
  const hash = r.content_hash ? String(r.content_hash) : undefined;
  const onDisk = readMaterializedFile(root, id, name, hash);
  if (onDisk !== null) return onDisk;
  const row = await loadRow(id);
  if (!row) return null;
  if (name === 'manifest.json') return row.manifest;
  return typeof row.files[name] === 'string' ? row.files[name] : null;
}

/** Ids this node has copies of that the database no longer has (for tests and diagnostics). */
export function localCopies(root = widgetFilesRoot()): string[] {
  return materializedIds(root);
}

export { hash16 };

// ---- the background check ------------------------------------------------------------------------------------

const CHECK_EVERY_MS = 15_000;
const g = globalThis as unknown as { __bosunPackageSync?: { timer: NodeJS.Timeout; last: string } };

/** Sync now and then every few seconds, once per process. Errors are logged when they change, not on every tick. */
export function startPackageFileSync(): void {
  if (g.__bosunPackageSync) return;
  const state = { timer: undefined as unknown as NodeJS.Timeout, last: '' };
  const tick = async () => {
    try {
      const r = await syncPackageFiles();
      const msg = r.failed.map(f => `${f.id}: ${f.error}`).join('; ');
      if (r.written.length || r.removed.length) console.log(`[widgets] files: wrote ${r.written.join(', ') || 'nothing'}${r.removed.length ? `, removed ${r.removed.join(', ')}` : ''}`);
      if (msg !== state.last) { if (msg) console.warn(`[widgets] could not write package files: ${msg}`); state.last = msg; }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg !== state.last) { console.warn(`[widgets] file sync: ${msg}`); state.last = msg; }
    }
  };
  state.timer = setInterval(tick, CHECK_EVERY_MS);
  state.timer.unref?.();
  g.__bosunPackageSync = state;
  void tick();
}
