/**
 * Writing a widget package to disk on the node that runs this process.
 *
 * The database is the only source of truth and the only thing nodes share: a package (manifest and files) is stored
 * in `widget_packages`. Each node writes the package into a folder of its own when it appears or changes, so nothing
 * else has to synchronise files between the nodes of a cluster.
 *
 * Layout under the root (`widgetFilesRoot()`):
 *
 *   <id>/<hash16>/manifest.json, <the package's files>, .bosun-package.json   one complete, verified copy
 *   <id>/CURRENT                                                              names the copy to use (hash16)
 *
 * A copy is written into a temporary folder and renamed into place, then `CURRENT` is replaced with a rename, so a
 * reader sees either the old copy or the new one, never a half-written one. The content hash covers the manifest and
 * every file; a copy whose stored hash does not match what is written is refused. This module has no database access
 * (see materialize-db.ts), so it can be tested with a temporary folder.
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

const PACKAGE_ID_RE = /^[a-z][a-z0-9_]{1,39}$/;
const FILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
const HASH16_RE = /^[0-9a-f]{16}$/;
const META_FILE = '.bosun-package.json';
const STALE_TEMP_MS = 60 * 60 * 1000;

export type PackageFiles = Record<string, string>;

export interface PackageCopy {
  id: string;
  version: string;
  /** manifest.json as stored (JSON text). */
  manifest: string;
  files: PackageFiles;
  /** The content hash stored in the database, when there is one; a mismatch with the content is refused. */
  contentHash?: string | null;
}

const sha256 = (text: string) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

/** The hash of a package's content: its manifest and its files (names and bytes), independent of their order. */
export function contentHashOf(manifest: string, files: PackageFiles): string {
  const h = crypto.createHash('sha256');
  h.update(`manifest ${sha256(manifest)}\n`);
  for (const name of Object.keys(files).sort()) h.update(`file ${name} ${sha256(files[name])}\n`);
  return h.digest('hex');
}

/** Where this node keeps materialised packages (`BOSUN_WIDGETS_DIR`, else a folder in the temp directory). */
export function widgetFilesRoot(): string {
  return process.env.BOSUN_WIDGETS_DIR || path.join(os.tmpdir(), 'bosun-widgets');
}

export const hash16 = (hash: string) => hash.slice(0, 16);

function assertSafeName(name: string): void {
  if (!FILE_NAME_RE.test(name) || name.split('/').some(p => p === '.' || p === '..') || name === 'manifest.json') {
    throw new Error(`unsafe file name "${name}"`);
  }
}

/** The copy this node currently uses for a package (its hash16), or null. */
export function currentCopy(root: string, id: string): string | null {
  if (!PACKAGE_ID_RE.test(id)) return null;
  try {
    const v = fs.readFileSync(path.join(root, id, 'CURRENT'), 'utf8').trim();
    return HASH16_RE.test(v) ? v : null;
  } catch { return null; }
}

function metaOf(dir: string): { contentHash?: string } | null {
  try { return JSON.parse(fs.readFileSync(path.join(dir, META_FILE), 'utf8')); } catch { return null; }
}

/** Replace a small file atomically. */
function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o644 });
  fs.renameSync(tmp, file);
}

export interface MaterializeResult {
  dir: string;
  hash: string;
  /** False when this exact content was already in place. */
  written: boolean;
}

/**
 * Make `copy` the one this node uses. Throws on an unsafe file name, a hash that does not match the content, or an I/O
 * error; the previous copy is left untouched in that case.
 */
export function materializePackage(root: string, copy: PackageCopy): MaterializeResult {
  if (!PACKAGE_ID_RE.test(copy.id)) throw new Error(`invalid package id "${copy.id}"`);
  for (const name of Object.keys(copy.files)) assertSafeName(name);
  const hash = contentHashOf(copy.manifest, copy.files);
  if (copy.contentHash && copy.contentHash !== hash) {
    throw new Error(`the stored content hash of "${copy.id}" does not match its content (refusing to write it)`);
  }
  const short = hash16(hash);
  const pkgDir = path.join(root, copy.id);
  const target = path.join(pkgDir, short);
  fs.mkdirSync(pkgDir, { recursive: true, mode: 0o755 });

  let written = false;
  if (metaOf(target)?.contentHash !== hash) {
    const tmp = path.join(pkgDir, `.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
    try {
      fs.mkdirSync(tmp, { recursive: true, mode: 0o755 });
      fs.writeFileSync(path.join(tmp, 'manifest.json'), copy.manifest, { mode: 0o644 });
      for (const [name, content] of Object.entries(copy.files)) {
        const file = path.join(tmp, ...name.split('/'));
        if (!path.resolve(file).startsWith(path.resolve(tmp) + path.sep)) throw new Error(`unsafe file name "${name}"`);
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
        fs.writeFileSync(file, content, { mode: 0o644 });
      }
      fs.writeFileSync(path.join(tmp, META_FILE), JSON.stringify({ id: copy.id, version: copy.version, contentHash: hash, files: Object.keys(copy.files).sort() }), { mode: 0o644 });
      fs.rmSync(target, { recursive: true, force: true });   // an incomplete leftover under the same name
      fs.renameSync(tmp, target);
      written = true;
    } catch (err) {
      fs.rmSync(tmp, { recursive: true, force: true });
      throw err;
    }
  }

  const before = currentCopy(root, copy.id);
  if (before !== short) writeAtomic(path.join(pkgDir, 'CURRENT'), `${short}\n`);
  prune(pkgDir, short, before);
  return { dir: target, hash, written };
}

/** Remove copies nobody uses any more: all but the current one and the one before it, and old temporary folders. */
function prune(pkgDir: string, keep: string, previous: string | null): void {
  let names: string[] = [];
  try { names = fs.readdirSync(pkgDir); } catch { return; }
  const now = Date.now();
  for (const n of names) {
    const p = path.join(pkgDir, n);
    try {
      if (HASH16_RE.test(n)) { if (n !== keep && n !== previous) fs.rmSync(p, { recursive: true, force: true }); }
      else if (n.startsWith('.tmp-')) { if (now - fs.statSync(p).mtimeMs > STALE_TEMP_MS) fs.rmSync(p, { recursive: true, force: true }); }
    } catch { /* best effort */ }
  }
}

/** Remove everything this node holds for a package. */
export function removeMaterialized(root: string, id: string): boolean {
  if (!PACKAGE_ID_RE.test(id)) return false;
  const dir = path.join(root, id);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

/** The package ids this node holds copies of. */
export function materializedIds(root: string): string[] {
  try { return fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory() && PACKAGE_ID_RE.test(e.name)).map(e => e.name); } catch { return []; }
}

/**
 * A file of the copy this node uses (or null). With `expectHash` the copy must be that content, so a stale copy is
 * never read by mistake (the caller then falls back to the database).
 */
export function readMaterializedFile(root: string, id: string, name: string, expectHash?: string): string | null {
  const short = currentCopy(root, id);
  if (!short || (expectHash && hash16(expectHash) !== short)) return null;
  if (name !== 'manifest.json') { try { assertSafeName(name); } catch { return null; } }
  try { return fs.readFileSync(path.join(root, id, short, ...name.split('/')), 'utf8'); } catch { return null; }
}

/** What each package in the list needs: nothing (up to date), or writing. */
export function plan(root: string, rows: { id: string; contentHash: string }[]): { write: string[]; remove: string[]; keep: string[] } {
  const wanted = new Set(rows.map(r => r.id));
  const write: string[] = [];
  const keep: string[] = [];
  for (const r of rows) (currentCopy(root, r.id) === hash16(r.contentHash) ? keep : write).push(r.id);
  const remove = materializedIds(root).filter(id => !wanted.has(id));
  return { write, remove, keep };
}
