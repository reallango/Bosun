/**
 * REST/MCP parity: every route+method an API key can call must have an MCP tool, unless it is in
 * `parity.allow.json` with a reason. `parity.test.ts` walks `src/app/api` and enforces this.
 *
 * The mapping is declared on the tools themselves (`routes: ['GET servers/[serverId]', ...]`), so adding a REST route
 * without a tool fails the test instead of silently widening the gap.
 */
import { coreTools } from './tools';
import { hostTools } from './host-tools';
import { restTools } from './rest-tools';
import allowJson from './parity.allow.json';
import type { CatalogTool } from './types';

export interface AllowEntry {
  route: string;
  reason: string;
  note?: string;
}

export const VALID_ALLOW_REASONS = new Set([
  'browser-only auth flow',
  'ws-token',
  'mcp endpoint',
  'covered by another tool',
  'proxy catch-all',
]);

/**
 * Routes served by generated widget tools rather than one declared tool per route: the tool name depends on the
 * installed package and is built at runtime.
 */
export const WIDGET_ROUTE_COVERAGE = [
  'GET servers/[serverId]/widget-data/[widgetType]',
  'POST servers/[serverId]/widget-datasets/[widgetType]/[datasetId]',
  'POST servers/[serverId]/widget-actions/[widgetType]/[actionId]',
];

export function allowList(): AllowEntry[] {
  return (allowJson as { routes: AllowEntry[] }).routes;
}

/** Core, host and REST tools. Widget tools are generated from installed packages at runtime. */
export function allDeclaredTools(): CatalogTool[] {
  return [...coreTools(), ...hostTools(), ...restTools()];
}

/** route+method -> names of the tools that cover it. */
export function mappedRoutes(tools: CatalogTool[] = allDeclaredTools()): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const tool of tools) {
    for (const route of tool.routes ?? []) {
      const names = out.get(route) ?? [];
      names.push(tool.name);
      out.set(route, names);
    }
  }
  for (const route of WIDGET_ROUTE_COVERAGE) {
    const names = out.get(route) ?? [];
    names.push('generated widget tool');
    out.set(route, names);
  }
  return out;
}

export interface ParityReport {
  /** Actual route+method pairs with neither a tool nor an allow-list entry. */
  missing: string[];
  /** Tool route declarations that do not match a real route. */
  unknownToolRoutes: string[];
  /** Allow-list entries that do not match a real route. */
  unknownAllowRoutes: string[];
  /** Allow-list entries with a reason outside VALID_ALLOW_REASONS. */
  invalidReasons: string[];
  /** Tool names declared twice. */
  duplicateToolNames: string[];
  /** Tools with no description or no input schema. */
  incompleteTools: string[];
  /** A route+method covered by more than one declared tool (allowed, reported for clarity). */
  sharedRoutes: Record<string, string[]>;
}

/** Compare the real routes with the declared tools and allow-list. Pure: the caller supplies the real route list. */
export function checkParity(actualRoutes: string[], tools: CatalogTool[] = allDeclaredTools()): ParityReport {
  const mapped = mappedRoutes(tools);
  const allowed = new Map(allowList().map(e => [e.route, e]));
  const actual = new Set(actualRoutes);
  const missing = actualRoutes.filter(r => !mapped.has(r) && !allowed.has(r));
  const unknownToolRoutes = Array.from(mapped.keys()).filter(r => !actual.has(r));
  const unknownAllowRoutes = Array.from(allowed.keys()).filter(r => !actual.has(r));
  const invalidReasons = allowList().filter(e => !VALID_ALLOW_REASONS.has(e.reason)).map(e => `${e.route}: ${e.reason}`);
  const seen = new Set<string>();
  const duplicateToolNames: string[] = [];
  for (const t of tools) {
    if (seen.has(t.name)) duplicateToolNames.push(t.name);
    seen.add(t.name);
  }
  const incompleteTools = tools
    .filter(t => !t.description?.trim() || !t.inputSchema || t.inputSchema.type !== 'object')
    .map(t => t.name);
  const sharedRoutes = Object.fromEntries(Array.from(mapped.entries()).filter(([, names]) => names.length > 1));
  return { missing, unknownToolRoutes, unknownAllowRoutes, invalidReasons, duplicateToolNames, incompleteTools, sharedRoutes };
}
