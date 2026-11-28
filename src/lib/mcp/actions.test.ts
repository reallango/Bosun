import { describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { permissionRequestBody } from '@/lib/permissions/authorize';
import { buildWidgetTools } from './tools';
import { callWidgetAction, type WidgetDeps } from './actions';
import { sampleSource } from '../../../test/mcp-fixtures';

const loaded = { type: 'sample_widget', packageId: 'sample', spec: sampleSource.spec, network: [], credentials: [] };
const ctx = { auth: { userId: 'u1', username: 'uma', role: 'user' }, ip: '127.0.0.1' };
const restart = buildWidgetTools([sampleSource], () => true).find(t => t.actionId === 'restart')!;

function deps(overrides: Partial<WidgetDeps> = {}): WidgetDeps {
  return {
    loadWidgetSpec: async () => loaded,
    serverVisible: async () => true,
    requirePermission: async () => null,
    viewFilter: async () => 'all',
    loadDataset: async () => ({ data: [], collectedAt: 'now' }),
    filterRows: data => data,
    resolveTarget: async () => ({ kind: 'container', name: 'web' }),
    runWidgetAction: vi.fn(async () => NextResponse.json({ data: { success: true, message: 'done' } })),
    openTerminalAction: vi.fn(async () => NextResponse.json({ data: { token: 't' } })),
    consumeActionRateLimit: () => ({ allowed: true }),
    ...overrides,
  };
}

describe('MCP widget actions', () => {
  it('refuses a destructive action without confirm: true', async () => {
    const d = deps();
    const result = await callWidgetAction(ctx, restart, { server_id: 's1', name: 'web', force: true }, d);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Confirmation required: Restart it?');
    expect(d.runWidgetAction).not.toHaveBeenCalled();
  });

  it('runs the action when confirm: true is present', async () => {
    const d = deps();
    const result = await callWidgetAction(ctx, restart, { server_id: 's1', name: 'web', force: true, confirm: true }, d);
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('done');
    expect(d.runWidgetAction).toHaveBeenCalledOnce();
  });

  it('returns the REST access-request hint when permission is refused', async () => {
    const denied = NextResponse.json(
      {
        data: null,
        error: {
          message: 'Not permitted: requires the "Manage the sample" permission for the container "web"',
          code: 'FORBIDDEN',
          permission: 'sample.manage',
          resource: { kind: 'container', name: 'web' },
          request: permissionRequestBody('sample.manage', { kind: 'container', name: 'web' }, 's1'),
        },
      },
      { status: 403 },
    );
    const d = deps({ requirePermission: async () => denied });
    const result = await callWidgetAction(ctx, restart, { server_id: 's1', name: 'web', force: true, confirm: true }, d);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Not permitted');
    expect(result.content[0].text).toContain('POST /api/access-requests');
    expect(result.content[0].text).toContain('"permission":"sample.manage"');
    expect(result.content[0].text).toContain('"server_id":"s1"');
    expect(d.runWidgetAction).not.toHaveBeenCalled();
  });
});
