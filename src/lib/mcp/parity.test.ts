import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { allowList, checkParity, mappedRoutes, VALID_ALLOW_REASONS, allDeclaredTools } from './parity';

const API_DIR = path.resolve(__dirname, '../../app/api');
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'] as const;

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...routeFiles(full));
    else if (entry.name === 'route.ts') out.push(full);
  }
  return out;
}

/** Exported HTTP handlers in one route file. */
function exportedMethods(source: string): string[] {
  const re = new RegExp(`^export\\s+(?:async\\s+)?(?:function|const)\\s+(${METHODS.join('|')})\\b`, 'gm');
  return Array.from(source.matchAll(re)).map(m => m[1]);
}

/** Every real route+method, e.g. "GET servers/[serverId]". */
function actualRoutes(): string[] {
  const out: string[] = [];
  for (const file of routeFiles(API_DIR).sort()) {
    const route = path.relative(API_DIR, file).replace(/\\/g, '/').replace(/\/route\.ts$/, '');
    const source = fs.readFileSync(file, 'utf8');
    for (const method of exportedMethods(source)) out.push(`${method} ${route}`);
  }
  return out;
}

describe('MCP parity with the REST API', () => {
  const actual = actualRoutes();

  it('finds the REST routes it is meant to check', () => {
    expect(actual.length).toBeGreaterThan(100);
    expect(actual).toContain('GET servers/[serverId]');
    expect(actual).toContain('POST servers/[serverId]/power');
  });

  it('has a tool or an allow-listed reason for every route+method', () => {
    const report = checkParity(actual);
    expect(report.missing, `Add a tool (declaring routes) or an allow-list entry for:\n${report.missing.join('\n')}`).toEqual([]);
  });

  it('does not declare tools for routes that no longer exist', () => {
    expect(checkParity(actual).unknownToolRoutes).toEqual([]);
  });

  it('does not keep stale allow-list entries', () => {
    expect(checkParity(actual).unknownAllowRoutes).toEqual([]);
  });

  it('only uses valid allow-list reasons, and keeps the list short', () => {
    const entries = allowList();
    expect(entries.length).toBeLessThan(40);
    expect(checkParity(actual).invalidReasons).toEqual([]);
    for (const e of entries) expect(VALID_ALLOW_REASONS.has(e.reason), `${e.route}: ${e.reason}`).toBe(true);
  });

  it('gives every tool a unique name, a description and an object input schema', () => {
    const report = checkParity(actual);
    expect(report.duplicateToolNames).toEqual([]);
    expect(report.incompleteTools).toEqual([]);
  });

  it('maps the exec and terminal routes to the host tools', () => {
    const mapped = mappedRoutes();
    expect(mapped.get('POST servers/[serverId]/exec')).toContain('server_command');
    expect(mapped.get('POST servers/[serverId]/shell/exec')).toContain('server_command');
    expect(mapped.get('POST servers/[serverId]/terminal')).toContain('terminal_open');
  });

  it('covers widget data, datasets and actions through generated tools', () => {
    const mapped = mappedRoutes();
    for (const route of [
      'GET servers/[serverId]/widget-data/[widgetType]',
      'POST servers/[serverId]/widget-datasets/[widgetType]/[datasetId]',
      'POST servers/[serverId]/widget-actions/[widgetType]/[actionId]',
    ]) expect(mapped.get(route)).toContain('generated widget tool');
  });

  it('registers a route loader for every REST-backed tool', () => {
    const source = fs.readFileSync(path.resolve(__dirname, 'rest-routes.ts'), 'utf8');
    const registered = new Set(
      Array.from(source.matchAll(/^\s*"([^"]+)":\s*\(\)\s*=>\s*import\(/gm)).map(m => m[1]),
    );
    const used = new Set(allDeclaredTools().filter(t => t.rest).map(t => t.rest!.route));
    const missing = Array.from(used).filter(route => !registered.has(route));
    expect(missing, `Add a loader to rest-routes.ts for:\n${missing.join('\n')}`).toEqual([]);
  });

  it('declares the package-secret tool without ever returning a value', () => {
    const secret = allDeclaredTools().find(t => t.name === 'widget_package_secret_set');
    expect(secret).toBeTruthy();
    expect(secret!.description.toLowerCase()).toContain('never returned');
    expect(JSON.stringify(secret!.inputSchema)).toContain('value');
  });
});
