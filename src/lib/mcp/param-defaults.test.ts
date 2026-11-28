import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { readBundledPackages } from '@/lib/widgets/bundled';
import { validateParams } from '@/lib/widgets/runtime/command';
import { validateParamValues } from '@/lib/widgets/runtime/script-run';
import { resolveScriptArgs, selectVariant, typedParams } from '@/lib/widgets/runtime/script-action';
import type { ActionSpec, WidgetSpec } from '@/lib/widgets/runtime/spec';
import type { PackageManifest } from '@/lib/widgets/package-manifest';
import type { CredentialKindDef } from '@/lib/widgets/credentials-schema';
import { resolveCredentialUses } from '@/lib/widgets/credentials';
import { buildWidgetTools, type WidgetToolSource } from './tools';
import { callWidgetAction, type WidgetDeps } from './actions';
import { actionInputSchema, datasetInputSchema } from './schema';

const query = vi.hoisted(() => vi.fn(async () => { throw new Error('the credential store must not be queried'); }));
vi.mock('@/lib/db/rqlite-client', () => ({
  rqlite: { query, execute: vi.fn(async () => { throw new Error('the credential store must not be queried'); }) },
  rowsToObjects: () => [],
}));

const root = path.join(process.cwd(), 'widgets');
const { packages } = readBundledPackages(root);
const docker = packages.find(p => p.manifest.id === 'docker')! as { manifest: PackageManifest };
const dockerWidget = docker.manifest.widgets[0];
const dockerSpec = dockerWidget.spec as WidgetSpec;
const dockerKinds = docker.manifest.credentials as CredentialKindDef[];

const dockerSource: WidgetToolSource = {
  type: dockerWidget.type,
  displayName: String(dockerWidget.columns.display_name ?? dockerWidget.type),
  packageId: docker.manifest.id,
  spec: dockerSpec,
  permissionLabels: Object.fromEntries(docker.manifest.permissions.map(p => [p.id, p.label])),
  permissionRisks: Object.fromEntries(docker.manifest.permissions.map(p => [p.id, p.risk])),
};

const stackDeploy = buildWidgetTools([dockerSource], () => true).find(t => t.actionId === 'stack_deploy')!;

function deps(overrides: Partial<WidgetDeps> = {}): WidgetDeps {
  return {
    loadWidgetSpec: async () => ({ type: dockerWidget.type, packageId: docker.manifest.id, spec: dockerSpec, network: [], credentials: dockerKinds }),
    serverVisible: async () => true,
    requirePermission: async () => null,
    viewFilter: async () => 'all',
    loadDataset: async () => ({ data: [], collectedAt: 'now' }),
    filterRows: data => data,
    resolveTarget: async () => ({ kind: 'stack', name: 'web' }),
    runWidgetAction: vi.fn(async () => NextResponse.json({ data: { success: true } })),
    openTerminalAction: vi.fn(async () => NextResponse.json({ data: {} })),
    consumeActionRateLimit: () => ({ allowed: true }),
    ...overrides,
  };
}

describe('stack_deploy through the MCP action path', () => {
  it('fills every omitted parameter with its declared default and does not look up a credential for an editor stack', async () => {
    const d = deps();
    const result = await callWidgetAction(
      { auth: { userId: 'u1', username: 'uma', role: 'user' }, ip: '127.0.0.1' },
      stackDeploy,
      { server_id: 's1', name: 'web', source: 'editor', yaml: 'services: {}' },
      d,
    );
    expect(result.isError).toBeUndefined();
    const body = (d.runWidgetAction as ReturnType<typeof vi.fn>).mock.calls[0][4] as { params: Record<string, unknown> };
    expect(body.params).toEqual({ name: 'web', source: 'editor', yaml: 'services: {}' });

    const action = dockerSpec.actions.find(a => a.id === 'stack_deploy') as ActionSpec;
    const validated = validateParams(action, body.params);
    expect(validated).toMatchObject({
      yaml: 'services: {}', env: '', override: '', repo: '-', branch: '-', file: '-', pull: 'false', credential: 'auto',
    });

    const ctx = { param: typedParams(action.params, validated) };
    const variant = selectVariant(action, ctx)!;
    const script = dockerSpec.scripts![variant.script];
    const args = resolveScriptArgs(variant, script, ctx);
    const values = validateParamValues(script.params, args);
    expect(values).toMatchObject({
      yaml: 'services: {}', env: '', override: '', repo: '-', branch: '-', file: '-', pull: 'false', credential: 'auto',
    });

    expect(query).not.toHaveBeenCalled();
    expect(await resolveCredentialUses('docker', dockerKinds, variant.credentials, values, 's1', 'docker:stack_deploy'))
      .toEqual({ env: {}, secrets: [] });
  });

  it('accepts a "-" or "" credential as no choice and still resolves a git source by URL', () => {
    const action = dockerSpec.actions.find(a => a.id === 'stack_deploy') as ActionSpec;
    const cases: Array<[string | undefined, string]> = [['-', '-'], ['', 'auto'], [undefined, 'auto']];
    for (const [credential, expected] of cases) {
      const validated = validateParams(action, { name: 'web', source: 'git', repo: 'https://github.com/my-org/my-repo', ...(credential === undefined ? {} : { credential }) });
      expect(validated.credential, String(credential)).toBe(expected);
    }
  });
});

describe('MCP schema and runtime agree on which parameters are required', () => {
  function withoutDefaults(params: Record<string, { default?: unknown }> | undefined): string[] {
    return Object.entries(params ?? {}).filter(([, p]) => p.default === undefined).map(([name]) => name);
  }

  function runtimeActionRequired(action: ActionSpec): string[] {
    if (action.kind === 'terminal') return ['server_id', 'ref'];
    const required = new Set(withoutDefaults(action.params));
    if (action.confirm) required.add('confirm');
    return ['server_id', ...Array.from(required)];
  }

  it('matches for every action of every bundled package (including confirm and the target-kind parameters)', () => {
    let checked = 0;
    for (const { manifest } of packages) {
      for (const widget of manifest.widgets) {
        const spec = widget.spec as WidgetSpec;
        for (const action of spec.actions) {
          if (action.kind === 'screen') continue;
          const published = actionInputSchema(action).required ?? [];
          expect(new Set(published), `${manifest.id}/${widget.type}/${action.id}`).toEqual(new Set(runtimeActionRequired(action)));
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(30);
  });

  it('matches for every dataset of every bundled package', () => {
    let checked = 0;
    for (const { manifest } of packages) {
      for (const widget of manifest.widgets) {
        const spec = widget.spec as WidgetSpec;
        for (const [id, ds] of Object.entries(spec.datasets ?? {})) {
          const script = spec.scripts?.[ds.script];
          expect(script, `${manifest.id}/${widget.type}/${id}`).toBeDefined();
          const published = datasetInputSchema(script!.params).required ?? [];
          expect(new Set(published), `${manifest.id}/${widget.type}/${id}`).toEqual(new Set(['server_id', ...withoutDefaults(script!.params)]));
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(10);
  });

  it('keeps stack_deploy to just the arguments a source needs', () => {
    expect(new Set(actionInputSchema(dockerSpec.actions.find(a => a.id === 'stack_deploy')!).required))
      .toEqual(new Set(['server_id', 'name', 'source']));
  });
});
