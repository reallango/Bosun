/**
 * System widgets: the widgets that ship inside Bosun (compiled into the registry, plus Ollama
 * Status). Each is presented as a package so the management page can list it, but it is
 * built in: it has no database row, cannot be removed or upgraded from a package, and its
 * version moves with Bosun itself. Versions start at 0.0.1.
 */
import { widgetRegistry } from '@/components/widgets/registry';
import { CATALOG } from '@/lib/permissions/catalog';

export const SYSTEM_WIDGET_VERSION = '0.0.1';

/** Per-widget version overrides: bump an entry when that widget changes in a release. */
const VERSION_OVERRIDES: Record<string, string> = {};

/** System widgets that are not in the compiled registry (they are defined by a built-in database row). */
const EXTRA_SYSTEM_WIDGETS: { type: string; name: string; description: string }[] = [];

export interface SystemPackage {
  /** Same as the widget type. */
  id: string;
  name: string;
  version: string;
  description: string;
  widgetTypes: string[];
  /** Ids of the permissions this widget introduces (from the catalog). */
  permissions: string[];
}

export function systemPackages(): SystemPackage[] {
  const widgets = [
    ...Object.values(widgetRegistry).map(d => ({ type: d.type, name: d.displayName, description: d.description })),
    ...EXTRA_SYSTEM_WIDGETS,
  ];
  return widgets.map(w => ({
    id: w.type,
    name: w.name,
    version: VERSION_OVERRIDES[w.type] ?? SYSTEM_WIDGET_VERSION,
    description: w.description,
    widgetTypes: [w.type],
    permissions: CATALOG.filter(p => p.source === `widget:${w.type}`).map(p => p.id),
  }));
}

/** Widget types and package ids a downloaded or imported package may never take over. */
export function reservedPackageNames(): { types: string[]; ids: string[] } {
  const all = systemPackages();
  const names = Array.from(new Set(all.flatMap(p => [p.id, ...p.widgetTypes])));
  return { types: names, ids: names };
}
