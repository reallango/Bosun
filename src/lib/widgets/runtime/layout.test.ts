import { describe, it, expect } from 'vitest';
import { visible, visibleBadges, coerceParam, actionApplies, formInitial, formParams, selectParams, selectCurrent, text, jobHeadline, JOB_ACTIVE, type PublicActionLike } from './layout';
import type { FormField } from './spec-v2';

const ctx = {
  data: { models: [{ name: 'a' }], n: 3 },
  state: { install: { kind: 'docker', version: '0.5.1', installed: true }, env: { context: 4096 } },
  config: { interval: 30 },
  lookups: { latest: '0.6.0' },
  server: { platform: 'linux', name: 'gamebed' },
  job: null,
};

describe('visibility', () => {
  it('shows a block without a condition, and tests the condition against the whole context', () => {
    expect(visible({}, ctx)).toBe(true);
    expect(visible({ when: { field: 'state.install.installed', equals: true } }, ctx)).toBe(true);
    expect(visible({ when: { field: 'state.install.kind', equals: 'service' } }, ctx)).toBe(false);
    expect(visible({ when: { field: 'lookups.latest', newerThan: 'state.install.version' } }, ctx)).toBe(true);
    expect(visible({ when: { all: [{ field: 'server.platform', equals: 'linux' }, { not: { field: 'data.n', gt: 5 } }] } }, ctx)).toBe(true);
  });
  it('filters badges by their own conditions', () => {
    const badges = [
      { text: 'Update available', color: 'amber' as const, when: { field: 'lookups.latest', newerThan: 'state.install.version' } },
      { text: 'Stopped', color: 'red' as const, when: { field: 'state.install.installed', equals: false } },
      { text: 'Docker', color: 'blue' as const },
    ];
    expect(visibleBadges(badges, ctx).map(b => b.text)).toEqual(['Update available', 'Docker']);
  });
});

describe('coerceParam', () => {
  it('gives each type its value, or undefined', () => {
    expect(coerceParam({ type: 'number', min: 0, max: 9, integer: true }, '4')).toBe(4);
    expect(coerceParam({ type: 'number', min: 0, max: 9, integer: true }, '')).toBeUndefined();
    expect(coerceParam({ type: 'number', min: 0, max: 9, integer: true }, 'abc')).toBeUndefined();
    expect(coerceParam({ type: 'boolean' }, 'true')).toBe(true);
    expect(coerceParam({ type: 'boolean' }, 'maybe')).toBeUndefined();
    expect(coerceParam({ type: 'string', maxLength: 9 }, 12)).toBe('12');
    expect(coerceParam({ type: 'string', maxLength: 9 }, undefined)).toBeUndefined();
  });
});

describe('actionApplies', () => {
  const act = (variants?: { when?: object }[]): PublicActionLike => ({ id: 'a', label: 'A', permission: 'p', kind: 'script', params: {}, result: 'none', after: 'none', ...(variants ? { variants } : {}) } as never);
  it('an action without variants always applies', () => expect(actionApplies(act(), ctx)).toBe(true));
  it('needs one variant that holds', () => {
    expect(actionApplies(act([{ when: { field: 'state.install.kind', equals: 'service' } }, { when: { field: 'state.install.kind', equals: 'docker' } }]), ctx)).toBe(true);
    expect(actionApplies(act([{ when: { field: 'state.install.kind', equals: 'service' } }]), ctx)).toBe(false);
    expect(actionApplies(act([{ when: { field: 'state.install.kind', equals: 'service' } }, {}]), ctx)).toBe(true);
  });
  it('tests variant conditions with the default parameters', () => {
    const a = { ...act([{ when: { field: 'param.mode', equals: 'fast' } }]), params: { mode: { type: 'string', maxLength: 9, values: ['fast'], default: 'fast' } } } as PublicActionLike;
    expect(actionApplies(a, ctx)).toBe(true);
  });
});

describe('forms', () => {
  const fields: FormField[] = [
    { name: 'context', label: 'Context length', input: 'number', value: 'state.env.context' },
    { name: 'model', label: 'Model', input: 'text' },
    { name: 'mode', label: 'Mode', input: 'select', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], value: 'state.nothing' },
  ];
  it('start with the current values, a select with its first option when there is none', () => {
    expect(formInitial(fields, ctx)).toEqual({ context: '4096', model: '', mode: 'a' });
  });
  it('map fields to action parameters (explicit mapping, same name, defaults) and name what is missing', () => {
    const action = { params: { length: { type: 'number', min: 1, max: 99999, integer: true }, model: { type: 'string', maxLength: 50 }, keep: { type: 'boolean', default: false } } };
    const ok = formParams(action as never, { params: { length: 'context' } }, fields, { context: '8192', model: 'llama', mode: 'a' });
    expect(ok).toEqual({ params: { length: 8192, model: 'llama', keep: false }, missing: [] });
    const bad = formParams(action as never, { params: { length: 'context' } }, fields, { context: '', model: '', mode: 'a' });
    expect(bad.missing).toEqual(['Context length', 'Model']);
  });
});

describe('selects', () => {
  const block = { type: 'select' as const, label: 'Mode', value: 'state.install.kind', options: [{ value: 'docker', label: 'Docker' }], action: 'set', param: 'mode' };
  it('reads the current choice', () => expect(selectCurrent(block, ctx)).toBe('docker'));
  it('builds the action parameters with the choice and defaults for the rest', () => {
    const action = { params: { mode: { type: 'string', maxLength: 9 }, restart: { type: 'boolean', default: true } } };
    expect(selectParams(action as never, 'mode', 'service')).toEqual({ params: { mode: 'service', restart: true }, ok: true });
    expect(selectParams({ params: { mode: { type: 'string', maxLength: 9 }, other: { type: 'number', min: 0, max: 1, integer: true } } } as never, 'mode', 'x').ok).toBe(false);
  });
});

describe('text and jobs', () => {
  it('fills templates from the whole context', () => {
    expect(text('v{state.install.version} (latest {lookups.latest}) on {server.name}', ctx)).toBe('v0.5.1 (latest 0.6.0) on gamebed');
  });
  it('describes a job in one line', () => {
    const j = (over = {}) => ({ id: '1', actionId: 'install', status: 'running' as const, steps: [], percent: 40, message: null, ...over });
    expect(jobHeadline(j(), 'Install')).toBe('Install is running (40%)');
    expect(jobHeadline(j({ status: 'success', message: 'done' }), 'Install')).toBe('Install finished: done');
    expect(jobHeadline(j({ status: 'error', message: 'disk full' }))).toBe('install failed: disk full');
    expect(jobHeadline(j({ status: 'cancelled' }))).toBe('install was cancelled');
    expect(JOB_ACTIVE(j())).toBe(true);
    expect(JOB_ACTIVE(j({ status: 'success' }))).toBe(false);
    expect(JOB_ACTIVE(null)).toBe(false);
  });
});
