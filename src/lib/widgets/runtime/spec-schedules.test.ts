import { describe, it, expect } from 'vitest';
import { validateWidgetSpec } from './spec';

const PERMS = ['pkg.view', 'pkg.control'];

const base = (): any => ({
  version: 2,
  data: { source: 'snapshot', section: 'services', permission: 'pkg.view' },
  view: { type: 'text', text: '{name}' },
  actions: [
    { id: 'restart', label: 'Restart', as: 'service', command: 'echo {{name}}', permission: 'pkg.control',
      params: { name: { type: 'string', pattern: '^[a-z]+$' } } },
    { id: 'noop', label: 'Noop', as: 'service', command: 'echo hi', permission: 'pkg.view' },
  ],
  scripts: {
    check: { as: 'service', linux: 'scripts/check.sh', params: {
      name: { type: 'string', pattern: '^[a-z]+$' },
      all: { type: 'boolean', default: false },
    } },
  },
  datasets: {
    findings: { script: 'check', permission: 'pkg.view' },
    stack_findings: { script: 'check', permission: 'pkg.view', target: { kind: 'stack', param: 'name' } },
  },
});

const ok = (spec: unknown) => {
  const r = validateWidgetSpec(spec, PERMS);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
const errorOf = (spec: unknown): string => {
  const r = validateWidgetSpec(spec, PERMS);
  return r.ok ? '' : r.error;
};

describe('the schedules a widget declares', () => {
  it('accepts a dataset kind with arguments, a condition and a notice', () => {
    expect(ok(base()).schedules).toBeUndefined();
    const s = base();
    s.schedules = [{
      id: 'check_updates', label: 'Check for updates', description: 'Reads the findings.',
      run: { dataset: 'findings' }, target: 'server',
      options: { args: { name: 'web', all: true }, keepRuns: 50 },
      notify: { when: { field: 'available', equals: true }, title: '{count} on {server}', message: 'Schedule {schedule}', severity: 'warning' },
    }];
    const value = ok(s);
    expect(value.schedules?.[0]).toMatchObject({
      id: 'check_updates', label: 'Check for updates', run: { dataset: 'findings' }, target: 'server',
      options: { args: { name: 'web', all: true }, keepRuns: 50 },
      notify: { severity: 'warning' },
    });
  });

  it('accepts an action kind whose required parameters are fixed', () => {
    const s = base();
    s.schedules = [{ id: 'restart_web', label: 'Restart web', run: { action: 'restart', params: { name: 'web' } } }];
    expect(ok(s).schedules?.[0].run).toEqual({ action: 'restart', params: { name: 'web' } });
  });

  it('does not let an action omit a required parameter, even one with a default', () => {
    const s = base();
    s.actions[1].params = { name: { type: 'string', pattern: '^[a-z]+$', default: 'web' } };
    s.schedules = [{ id: 'noop', label: 'Noop', run: { action: 'noop' } }];
    expect(errorOf(s)).toContain('needs the parameter "name"');
  });

  it('lets a dataset rely on its own defaults', () => {
    const s = base();
    s.schedules = [{ id: 'check', label: 'Check', run: { dataset: 'findings' }, options: { args: { name: 'web' } } }];
    expect(ok(s).schedules?.[0].run).toEqual({ dataset: 'findings' });
  });

  it('requires every dataset parameter to be fixed or come from the target', () => {
    const s = base();
    s.schedules = [{ id: 'check', label: 'Check', run: { dataset: 'findings' } }];
    expect(errorOf(s)).toContain('needs the parameter "name"');
  });

  it('fills a stack/container target from the schedule and refuses to also set it', () => {
    const s = base();
    s.schedules = [{ id: 'stack_check', label: 'Stack check', run: { dataset: 'stack_findings' }, target: 'stack' }];
    expect(ok(s).schedules?.[0].target).toBe('stack');
    const both = base();
    both.schedules = [{ id: 'stack_check', label: 'Stack check', run: { dataset: 'stack_findings' }, target: 'stack', options: { args: { name: 'web' } } }];
    expect(errorOf(both)).toContain('filled from the schedule\'s target');
  });

  it('refuses a stack target when the run is not for a stack, or no target is set', () => {
    const wrongRun = base();
    wrongRun.schedules = [{ id: 'stack_check', label: 'Stack check', run: { dataset: 'findings' }, target: 'stack', options: { args: { name: 'web' } } }];
    expect(errorOf(wrongRun)).toContain('needs a run that declares "stack"');
    const noTarget = base();
    noTarget.schedules = [{ id: 'stack_check', label: 'Stack check', run: { dataset: 'stack_findings' } }];
    expect(errorOf(noTarget)).toContain('set target to "stack"');
  });

  it('refuses notify on an action run and unknown datasets or actions', () => {
    const withNotify = base();
    withNotify.schedules = [{ id: 'restart_web', label: 'Restart', run: { action: 'restart', params: { name: 'web' } }, notify: { title: 'x', message: 'y' } }];
    expect(errorOf(withNotify)).toContain('only for dataset runs');
    const noDataset = base();
    noDataset.schedules = [{ id: 'nope', label: 'Nope', run: { dataset: 'nope' } }];
    expect(errorOf(noDataset)).toContain('must name one of the widget\'s datasets');
    const noAction = base();
    noAction.schedules = [{ id: 'nope', label: 'Nope', run: { action: 'nope' } }];
    expect(errorOf(noAction)).toContain('must name one of the widget\'s runnable actions');
  });

  it('rejects a parameter the run does not declare', () => {
    const s = base();
    s.schedules = [{ id: 'restart_web', label: 'Restart', run: { action: 'restart', params: { name: 'web', typo: 'x' } } }];
    expect(errorOf(s)).toContain('has no parameter "typo"');
  });

  it('rejects duplicate ids, bad ids, bad notices and version 1', () => {
    const one = { id: 'check', label: 'Check', run: { dataset: 'findings' }, options: { args: { name: 'web' } } };
    const twice = base();
    twice.schedules = [one, { ...one }];
    expect(errorOf(twice)).toContain('listed twice');
    const badId = base();
    badId.schedules = [{ ...one, id: 'Check me' }];
    expect(errorOf(badId)).toContain('ids are lowercase');
    const badSeverity = base();
    badSeverity.schedules = [{ ...one, notify: { title: 'x', message: 'y', severity: 'critical' } }];
    expect(errorOf(badSeverity)).toContain('severity must be');
    const v1 = base();
    v1.version = 1;
    v1.schedules = [one];
    expect(errorOf(v1)).toContain('needs spec version 2');
  });
});
