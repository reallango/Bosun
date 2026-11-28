import { describe, expect, it } from 'vitest';
import { buildWidgetTools, coreTools } from './tools';
import { sampleSource } from '../../../test/mcp-fixtures';

function props(tool: ReturnType<typeof buildWidgetTools>[number]): Record<string, Record<string, unknown>> {
  return (tool.inputSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
}

describe('MCP widget tools', () => {
  const tools = buildWidgetTools([sampleSource], () => true);
  const byName = new Map(tools.map(t => [t.name, t]));

  it('generates one tool per dataset and runnable action, and skips screens', () => {
    expect(Array.from(byName.keys())).toEqual([
      'sample_widget__containers',
      'sample_widget__rows',
      'sample_widget__restart',
      'sample_widget__status',
      'sample_widget__open',
    ]);
  });

  it('derives dataset schemas from the script parameters', () => {
    const ds = byName.get('sample_widget__containers')!;
    expect(ds.kind).toBe('dataset');
    expect(ds.annotations).toMatchObject({ readOnlyHint: true });
    expect(ds.inputSchema.required).toEqual(['server_id', 'stack']);
    expect(props(ds).server_id).toMatchObject({ type: 'string' });
    expect(props(ds).stack).toMatchObject({ type: 'string', enum: ['web', 'db'], maxLength: 20, description: 'Stack name' });
    expect(props(ds).all).toMatchObject({ type: 'boolean' });
    expect(ds.description).toContain('See sample data');
    expect(ds.description).toContain('one container');
  });

  it('derives action schemas, including required confirm for destructive actions', () => {
    const restart = byName.get('sample_widget__restart')!;
    expect(restart.kind).toBe('action');
    expect(restart.inputSchema.required).toEqual(expect.arrayContaining(['server_id', 'name', 'force', 'confirm']));
    expect(props(restart).name).toMatchObject({ type: 'string', pattern: '^[a-z]+$', maxLength: 20 });
    expect(props(restart).confirm).toMatchObject({ type: 'boolean', const: true });
    expect(restart.description).toContain('Restart it?');
    expect(restart.description).toContain('confirm: true');
    expect(restart.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  it('marks high-risk actions destructive even without a confirmation', () => {
    expect(byName.get('sample_widget__open')!.annotations).toMatchObject({ destructiveHint: true });
    expect(byName.get('sample_widget__status')!.annotations?.destructiveHint).toBeUndefined();
  });

  it('only lists what the caller may use, and says whether a whole-server grant is needed', () => {
    const seen: { permission: string; wholeServerOnly: boolean }[] = [];
    const filtered = buildWidgetTools([sampleSource], (permission, use) => {
      seen.push({ permission, ...use });
      return permission !== 'sample.manage';
    });
    expect(filtered.some(t => t.actionId === 'restart')).toBe(false);
    expect(filtered.some(t => t.datasetId === 'containers')).toBe(true);
    expect(seen).toContainEqual({ permission: 'sample.view', wholeServerOnly: false });
    expect(seen).toContainEqual({ permission: 'sample.view', wholeServerOnly: true });
    expect(seen).toContainEqual({ permission: 'sample.manage', wholeServerOnly: false });
    expect(seen).toContainEqual({ permission: 'sample.shell', wholeServerOnly: false });
  });

  it('keeps a tool for a widget whose package needs a newer Bosun here, instead of removing it silently', () => {
    const reason = 'This widget needs a newer Bosun on this node (API level 10; this node has 9). Finish updating the cluster.';
    const tools = buildWidgetTools([], () => true, [{ type: 'docker', displayName: 'Docker', reason }]);
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      kind: 'blocked', name: 'docker__unavailable', widgetType: 'docker', widgetDisplayName: 'Docker', blockedReason: reason,
    });
    expect(tools[0].description).toContain(reason);
    expect(tools[0].inputSchema).toMatchObject({ type: 'object' });
  });
});

describe('MCP core tools', () => {
  it('contains the fixed orientation, job, access, schedule, update and notification tools', () => {
    expect(coreTools().map(t => t.name)).toEqual([
      'bosun_overview', 'servers_list', 'server_get', 'job_wait', 'job_log',
      'access_whoami', 'access_request', 'access_request_wait',
      'schedules_list', 'schedule_create', 'schedule_run_now',
      'update_status', 'notifications_list',
      'credentials_list', 'credentials_create', 'credentials_update', 'credentials_delete',
    ]);
  });

  it('caps job_wait at two minutes and access_request_wait at fifty seconds', () => {
    const byName = new Map(coreTools().map(t => [t.name, t]));
    expect(props(byName.get('job_wait')!).timeout).toMatchObject({ type: 'integer', minimum: 1, maximum: 120 });
    expect(props(byName.get('access_request_wait')!).timeout).toMatchObject({ type: 'integer', minimum: 1, maximum: 50 });
  });
});
