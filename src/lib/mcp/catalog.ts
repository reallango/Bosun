/** Build the MCP tool catalog for one caller: core tools plus the widget tools that caller may use somewhere. */
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';
import { CATALOG } from '@/lib/permissions/catalog';
import { effectiveGrants } from '@/lib/permissions/effective';
import { grantsAllow } from '@/lib/permissions/evaluate';
import { allServerContexts, registeredPermissionDefs } from '@/lib/permissions/store';
import { loadWidgetSpec } from '@/lib/widgets/runtime/execute';
import type { TokenPayload } from '@/lib/auth/jwt';
import { buildWidgetTools, coreTools, type CanUse, type WidgetToolSource } from './tools';
import { buildCatalog, type McpToolCatalog } from './types';

async function loadWidgetSources(): Promise<WidgetToolSource[]> {
  const rows = rowsToObjects(await rqlite.query(
    'SELECT type, display_name FROM custom_widgets WHERE package_id IS NOT NULL AND spec IS NOT NULL AND enabled = 1 ORDER BY display_name',
  ));
  const defs = [...CATALOG, ...(await registeredPermissionDefs())];
  const permissionLabels = Object.fromEntries(defs.map(d => [d.id, d.label]));
  const permissionRisks = Object.fromEntries(defs.map(d => [d.id, d.risk])) as Record<string, 'low' | 'medium' | 'high'>;
  const out: WidgetToolSource[] = [];
  for (const row of rows) {
    const type = String(row.type);
    const loaded = await loadWidgetSpec(type).catch(() => null);
    if (!loaded) continue;
    out.push({
      type: loaded.type,
      displayName: String(row.display_name || type),
      packageId: loaded.packageId,
      spec: loaded.spec,
      permissionLabels,
      permissionRisks,
    });
  }
  return out;
}

/**
 * Whether the caller holds a permission on at least one visible server. A dataset or action that can be limited to
 * a stack/container also counts when the caller holds a limited grant; one that needs the whole server does not.
 */
async function permissionChecker(auth: TokenPayload): Promise<CanUse> {
  if (auth.role === 'admin') return () => true;
  const extra = await registeredPermissionDefs();
  const grants = await effectiveGrants(auth, extra, true);
  const servers = await allServerContexts();
  return (permission, use) => {
    for (const server of servers) {
      if (!grantsAllow(grants, 'servers.view', server, extra)) continue;
      if (grantsAllow(grants, permission, server, extra)) return true;
      // A grant limited to one stack/container still makes the tool usable there; a whole-server deny still wins.
      if (!use.wholeServerOnly && grantsAllow(grants, permission, server, extra, { anyResource: true })) return true;
    }
    return false;
  };
}

export async function loadToolCatalog(auth: TokenPayload): Promise<McpToolCatalog> {
  const [sources, canUse] = await Promise.all([loadWidgetSources(), permissionChecker(auth)]);
  return buildCatalog([...coreTools(), ...buildWidgetTools(sources, canUse)]);
}
