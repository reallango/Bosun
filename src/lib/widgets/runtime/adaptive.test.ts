import { describe, it, expect } from 'vitest';
import { infoLineText, pickAdaptive, visibleInfo } from './adaptive';
import type { Cond } from './spec';
import type { ViewContext } from './layout';

interface TestItem { label: string; when?: Cond; alternatives?: TestItem[] }
const pick = (item: TestItem, c: ViewContext) => pickAdaptive(item, c);

const ctx = (data: unknown): ViewContext => ({ data, config: {}, server: {}, datasets: {} } as ViewContext);

describe('pickAdaptive', () => {
  it('keeps an item without a condition, and hides one whose condition does not hold', () => {
    expect(pick({ label: 'always' }, ctx({}))).toEqual({ label: 'always' });
    expect(pick({ label: 'hidden', when: { field: 'data.n', gt: 0 } }, ctx({ n: 0 }))).toBeNull();
  });

  it('tries alternatives in order and takes the first whose condition holds', () => {
    const item = {
      label: 'Errors', when: { field: 'data.errors', gt: 0 }, alternatives: [
        { label: 'Uptime', when: { field: 'data.uptime', exists: true } },
        { label: 'Fallback' },
      ],
    };
    expect(pick(item, ctx({ errors: 2, uptime: 10 }))?.label).toBe('Errors');
    expect(pick(item, ctx({ errors: 0, uptime: 10 }))?.label).toBe('Uptime');
    expect(pick(item, ctx({ errors: 0 }))?.label).toBe('Fallback');
    expect(pick({ label: 'x', when: { field: 'data.n', gt: 0 } }, ctx({ n: 0 }))).toBeNull();
  });

  it('looks inside a nested alternative', () => {
    const item = {
      label: 'A', when: { field: 'data.a', equals: true }, alternatives: [
        { label: 'B', when: { field: 'data.b', equals: true }, alternatives: [{ label: 'C' }] },
      ],
    };
    expect(pick(item, ctx({ a: false, b: true }))?.label).toBe('B');
    expect(pick(item, ctx({ a: false, b: false }))?.label).toBe('C');
  });

  it('evaluates a count condition over the list at a path', () => {
    const item = { label: 'Mounts', when: { count: { path: 'data.mounts' }, gt: 1 }, alternatives: [{ label: 'One' }] };
    expect(pick(item, ctx({ mounts: [{}, {}] }))?.label).toBe('Mounts');
    expect(pick(item, ctx({ mounts: [{}] }))?.label).toBe('One');
  });
});

describe('info lines', () => {
  const items = [
    { label: 'Mounts', value: '{n}' },
    { label: 'eth0', value: '{ip}', when: { field: 'data.ip', exists: true } },
    { label: 'Uptime', value: '31d' },
  ];

  it('shows the pairs whose when holds', () => {
    expect(visibleInfo(items, ctx({ ip: '192.168.1.130' })).map(i => i.label)).toEqual(['Mounts', 'eth0', 'Uptime']);
    expect(visibleInfo(items, ctx({})).map(i => i.label)).toEqual(['Mounts', 'Uptime']);
  });

  it('joins label and value with a dot separator', () => {
    expect(infoLineText(items, ctx({ ip: '192.168.1.130' }), t => t.replace('{n}', '2').replace('{ip}', '192.168.1.130')))
      .toBe('Mounts 2 · eth0 192.168.1.130 · Uptime 31d');
    expect(infoLineText([], ctx({}), t => t)).toBe('');
  });
});
