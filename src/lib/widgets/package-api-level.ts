/**
 * What the installed package version of a widget type needs (`requires.api`), read from the shared database.
 *
 * A node whose widget API level is below it cannot load the type's spec: the spec uses keys that build does not know,
 * so validation fails and the type looks unknown. Reading the requirement from the package row lets the routes and
 * the MCP catalog say why, and what to do about it, instead.
 */
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';
import { nodeApiLevelProblem, requiredApiLevel, type WidgetApiRequires } from '@/lib/widgets/api-level';

/** The `requires` object of a stored manifest, if it names one. */
export function requiresOfManifest(manifest: unknown): WidgetApiRequires | undefined {
  const raw = manifest && typeof manifest === 'object' ? (manifest as { requires?: unknown }).requires : undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const api = (raw as { api?: unknown }).api;
  return typeof api === 'number' && Number.isFinite(api) ? { api } : undefined;
}

/** The level the installed package of `type` needs; undefined when the type has no package row. */
export async function installedTypeRequires(type: string): Promise<WidgetApiRequires | undefined> {
  const r = await rqlite.query(
    'SELECT p.manifest FROM custom_widgets w JOIN widget_packages p ON p.id = w.package_id WHERE w.type = ?', [type]);
  const row = rowsToObjects(r)[0];
  if (!row) return undefined;
  try {
    return requiresOfManifest(JSON.parse(String(row.manifest)));
  } catch {
    return undefined;
  }
}

/** Why this node cannot use the installed package of `type`, or null when it can (or the type is not a package). */
export async function widgetTypeApiProblem(type: string): Promise<string | null> {
  const requires = await installedTypeRequires(type).catch(() => undefined);
  return nodeApiLevelProblem(requires);
}

/** The level the installed package of `type` needs (1 when it names none). */
export async function installedTypeRequiredLevel(type: string): Promise<number> {
  return requiredApiLevel(await installedTypeRequires(type).catch(() => undefined));
}
