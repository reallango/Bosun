/**
 * Widget package manifests (`manifest.json`): validation and version handling.
 *
 * A package is a folder (GitHub `widgets/<id>/`) or a zip with a `manifest.json` at its root and
 * optional text files next to it. Installing one registers its widget types and the permissions
 * they introduce. Pure (no I/O) so it can be tested and used from routes and the browser.
 */
import { sanitizeCustomWidget, type CustomWidgetColumns } from '@/lib/widgets/custom-widget-input';
import { CATALOG } from '@/lib/permissions/catalog';
import { validateWidgetSpec, type WidgetSpec } from '@/lib/widgets/runtime/spec';

export const MANIFEST_SCHEMA = 1;
export const PACKAGE_ID_RE = /^[a-z][a-z0-9_]{1,39}$/;
export const WIDGET_TYPE_RE = /^[a-z][a-z0-9_]{0,63}$/;
export const VERSION_RE = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;

export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_FILES_BYTES = 1024 * 1024;
export const MAX_FILES = 40;
export const MAX_SPEC_BYTES = 64 * 1024;
const FILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

export interface PackageWidget {
  type: string;
  /** Column values ready for `custom_widgets` (JSON serialised, booleans as 0/1). */
  columns: CustomWidgetColumns;
  /** Declarative definition interpreted by the widget runtime; stored as given. */
  spec: WidgetSpec | null;
}

export interface PackagePermission {
  id: string;
  label: string;
  description: string;
  group: string;
  defaultLevel: 'operator' | 'admin';
  risk: 'low' | 'medium' | 'high';
  scope: 'server' | 'global';
  implies: string[];
}

export interface PackageManifest {
  schema: number;
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  widgets: PackageWidget[];
  permissions: PackagePermission[];
}

/** Text files shipped next to the manifest (relative path -> content). */
export type PackageFiles = Record<string, string>;

export type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

/** Negative when a < b, 0 when equal, positive when a > b. Both must be valid versions. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

function str(v: unknown, max: number): string | null {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= max ? v.trim() : null;
}

/**
 * Validate a parsed manifest. `reservedTypes` / `reservedIds` are the system widget types and
 * package ids a package must not take over.
 */
export function validateManifest(
  raw: unknown,
  opts: { reservedTypes?: readonly string[]; reservedIds?: readonly string[] } = {},
): Validated<PackageManifest> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('manifest.json must be a JSON object');
  const m = raw as Record<string, unknown>;
  if (m.schema !== MANIFEST_SCHEMA) return fail(`manifest "schema" must be ${MANIFEST_SCHEMA}`);

  const id = typeof m.id === 'string' ? m.id : '';
  if (!PACKAGE_ID_RE.test(id)) return fail('manifest "id" must be 2-40 characters: lowercase letters, digits and underscores, starting with a letter');
  if ((opts.reservedIds ?? []).includes(id)) return fail(`"${id}" is the id of a system package and cannot be used`);
  const name = str(m.name, 80);
  if (!name) return fail('manifest "name" is required (max 80 characters)');
  const version = typeof m.version === 'string' ? m.version : '';
  if (!VERSION_RE.test(version)) return fail('manifest "version" must look like 1.2.3');
  const description = m.description === undefined ? '' : (typeof m.description === 'string' && m.description.length <= 500 ? m.description : null);
  if (description === null) return fail('manifest "description" must be text (max 500 characters)');
  const author = m.author === undefined ? '' : (typeof m.author === 'string' && m.author.length <= 120 ? m.author : null);
  if (author === null) return fail('manifest "author" must be text (max 120 characters)');

  const permissions: PackagePermission[] = [];
  if (m.permissions !== undefined) {
    if (!Array.isArray(m.permissions) || m.permissions.length > 30) return fail('"permissions" must be a list of at most 30 entries');
    const catalogIds = new Set(CATALOG.map(p => p.id));
    const own = new Set<string>();
    for (const p of m.permissions as Record<string, unknown>[]) {
      const pid = typeof p?.id === 'string' ? p.id : '';
      if (!new RegExp(`^${id}\\.[a-z][a-z0-9_.]{0,40}$`).test(pid)) return fail(`permission ids must start with "${id}." (got "${pid}")`);
      if (catalogIds.has(pid) || own.has(pid)) return fail(`permission "${pid}" is declared twice or already exists`);
      const label = str(p.label, 100);
      const desc = str(p.description, 400);
      const group = str(p.group, 60);
      if (!label || !desc || !group) return fail(`permission "${pid}" needs a label, description and group`);
      if (p.defaultLevel !== 'operator' && p.defaultLevel !== 'admin') return fail(`permission "${pid}": defaultLevel must be "operator" or "admin"`);
      if (p.risk !== 'low' && p.risk !== 'medium' && p.risk !== 'high') return fail(`permission "${pid}": risk must be low, medium or high`);
      if (p.scope !== 'server' && p.scope !== 'global') return fail(`permission "${pid}": scope must be "server" or "global"`);
      const implies = p.implies === undefined ? [] : p.implies;
      if (!Array.isArray(implies) || implies.some(i => typeof i !== 'string')) return fail(`permission "${pid}": implies must be a list of permission ids`);
      own.add(pid);
      permissions.push({ id: pid, label, description: desc, group, defaultLevel: p.defaultLevel, risk: p.risk, scope: p.scope, implies: implies as string[] });
    }
    for (const p of permissions) {
      for (const i of p.implies) {
        if (!own.has(i) && !catalogIds.has(i)) return fail(`permission "${p.id}" implies unknown permission "${i}"`);
        // A package must not hand out a stronger built-in permission through "implies".
        if (!own.has(i) && (CATALOG.find(c => c.id === i)?.defaultLevel === 'admin' || CATALOG.find(c => c.id === i)?.risk === 'high')) {
          return fail(`permission "${p.id}" may not imply the built-in permission "${i}"`);
        }
      }
    }
  }

  if (!Array.isArray(m.widgets) || m.widgets.length < 1 || m.widgets.length > 10) return fail('"widgets" must list 1-10 widget types');
  const widgets: PackageWidget[] = [];
  const types = new Set<string>();
  for (const w of m.widgets as Record<string, unknown>[]) {
    const type = typeof w?.type === 'string' ? w.type : '';
    if (!WIDGET_TYPE_RE.test(type)) return fail(`widget type "${type}" must be a lowercase identifier`);
    if ((opts.reservedTypes ?? []).includes(type)) return fail(`widget type "${type}" belongs to a system widget and cannot be used`);
    if (types.has(type)) return fail(`widget type "${type}" is listed twice`);
    types.add(type);
    const v = sanitizeCustomWidget(w, true);
    if ('error' in v) return fail(`widget "${type}": ${v.error}`);
    let spec: WidgetSpec | null = null;
    if (w.spec !== undefined) {
      if (!w.spec || typeof w.spec !== 'object' || Array.isArray(w.spec)) return fail(`widget "${type}": "spec" must be an object`);
      if (JSON.stringify(w.spec).length > MAX_SPEC_BYTES) return fail(`widget "${type}": "spec" is too large`);
      const s = validateWidgetSpec(w.spec, permissions.map(p => p.id));
      if (!s.ok) return fail(`widget "${type}": ${s.error}`);
      spec = s.value;
    }
    widgets.push({ type, columns: v.values, spec });
  }

  return { ok: true, value: { schema: MANIFEST_SCHEMA, id, name, version, description, author, widgets, permissions } };
}

/** Validate the extra files of a package: text only, sane names, bounded size. */
export function validateFiles(files: Record<string, Uint8Array | string>): Validated<PackageFiles> {
  const out: PackageFiles = {};
  const names = Object.keys(files);
  if (names.length > MAX_FILES) return fail(`a package may contain at most ${MAX_FILES} files besides manifest.json`);
  let total = 0;
  for (const name of names) {
    if (!FILE_NAME_RE.test(name) || name.split('/').some(s => s === '.' || s === '..') || name.length > 120) return fail(`file name "${name}" is not allowed`);
    const data = files[name];
    let text: string;
    if (typeof data === 'string') text = data;
    else {
      if (data.includes(0)) return fail(`"${name}" is not a text file`);
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { return fail(`"${name}" is not valid UTF-8 text`); }
    }
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > MAX_FILE_BYTES) return fail(`"${name}" is larger than ${MAX_FILE_BYTES / 1024} KB`);
    total += bytes;
    if (total > MAX_FILES_BYTES) return fail(`a package's files may total at most ${MAX_FILES_BYTES / 1024} KB`);
    out[name] = text;
  }
  return { ok: true, value: out };
}

/** The manifest as written to `manifest.json` again (used by export). */
export function manifestToJson(m: PackageManifest): Record<string, unknown> {
  return {
    schema: m.schema, id: m.id, name: m.name, version: m.version, description: m.description, author: m.author,
    permissions: m.permissions,
    widgets: m.widgets.map(w => {
      const c = w.columns;
      const j = (s: unknown) => { try { return JSON.parse(String(s)); } catch { return undefined; } };
      return {
        type: w.type, display_name: c.display_name, description: c.description, icon: c.icon, category: c.category,
        default_size: j(c.default_size), min_size: j(c.min_size), refresh_interval: c.refresh_interval,
        supports_linux: c.supports_linux === undefined ? undefined : !!c.supports_linux,
        supports_windows: c.supports_windows === undefined ? undefined : !!c.supports_windows,
        config_schema: j(c.config_schema), ...(w.spec ? { spec: w.spec } : {}),
      };
    }),
  };
}
