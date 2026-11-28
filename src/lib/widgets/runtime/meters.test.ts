import { describe, it, expect } from 'vitest';
import { meterRowView, meterRows, validateMeters, visibleMeterRows, type MeterItem } from './meters';
import { countRows } from './stat';
import { formatValue } from './number-format';
import type { ViewContext } from './layout';

const ctx = (data: unknown): ViewContext => ({ data, config: {}, server: {}, datasets: {} } as ViewContext);

describe('meters', () => {
  it('validates a bar or ring block and its row template', () => {
    const ok = validateMeters({ path: 'data.mounts', shape: 'bar', item: { label: '{mount}', value: '{used_pct}', unit: '%' } }, 'w');
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value).toMatchObject({ path: 'data.mounts', shape: 'bar', item: { label: '{mount}', value: '{used_pct}', unit: '%' } });
    expect(validateMeters({ shape: 'pie', item: { label: '{x}', value: '{y}' } }, 'w').ok).toBe(false);
    expect(validateMeters({ item: { label: '{x}' } }, 'w').ok).toBe(false);
    expect(validateMeters({ path: 'data[0]', item: { label: '{x}', value: '{y}' } }, 'w').ok).toBe(false);
    expect(validateMeters({ shape: 'ring', item: { label: '{x}', value: '{y}', max: 0 } }, 'w').ok).toBe(false);
  });

  it('fills a row template and draws its share of the maximum', () => {
    const item: MeterItem = { label: '{mount}', value: '{used_pct}', unit: '%', max: 100, sub: '{fs} · {size}' };
    const view = meterRowView(item, { mount: '/srv/data', used_pct: 89.9, fs: '/dev/sdb1', size: '1.8 TB' });
    expect(view.label).toBe('/srv/data');
    expect(view.sub).toBe('/dev/sdb1 · 1.8 TB');
    expect(view.valueText).toBe('89.9%');
    expect(view.pct).toBeCloseTo(89.9);
    expect(view.tone).toBeNull();
  });

  it('uses thresholds and clamps the bar at 100', () => {
    const item: MeterItem = { label: '{mount}', value: '{used_pct}', unit: '%', thresholds: { warning: 75, danger: 90 } };
    expect(meterRowView(item, { mount: '/', used_pct: 95 }).tone).toBe('danger');
    expect(meterRowView(item, { mount: '/', used_pct: 95 }).pct).toBe(95);
    expect(meterRowView(item, { mount: '/', used_pct: 140 }).pct).toBe(100);
    expect(meterRowView(item, { mount: '/', used_pct: 40 }).tone).toBeNull();
  });

  it('reads the rows at a path, an object as one row and nothing as none', () => {
    expect(meterRows([{ a: 1 }, null, 'x', { b: 2 }])).toEqual([{ a: 1 }, { b: 2 }]);
    expect(meterRows({ a: 1 })).toEqual([{ a: 1 }]);
    expect(meterRows(null)).toEqual([]);
  });
});

describe('count tiles', () => {
  it('counts the list at a path, optionally only the rows matching a condition', () => {
    const c = ctx({ models: [{ state: 'running' }, { state: 'running' }, { state: 'stopped' }] });
    expect(countRows({ path: 'data.models' }, c)).toBe(3);
    expect(countRows({ path: 'data.models', where: { field: 'state', equals: 'running' } }, c)).toBe(2);
    expect(countRows({ path: 'data.missing' }, c)).toBe(0);
    expect(countRows({ path: 'data' }, ctx([]))).toBe(0);
  });

  it('counts an object as one row', () => {
    expect(countRows({ path: 'data.one' }, ctx({ one: { a: 1 } }))).toBe(1);
  });
});

describe('value formats', () => {
  it('writes bytes, rates, megabytes, temperatures, durations and percentages', () => {
    expect(formatValue(1536, 'bytes')).toBe('1.5 KB');
    expect(formatValue(1536, 'rate')).toBe('1.5 KB/s');
    expect(formatValue(2048, 'mb')).toBe('2.0 GB');
    expect(formatValue(512, 'mb')).toBe('512 MB');
    expect(formatValue(46.4, 'temp')).toBe('46°C');
    expect(formatValue(90061, 'duration')).toBe('1d 1h');
    expect(formatValue(89.94, 'percent')).toBe('89.9%');
  });

  it('keeps a value that is not a number as text', () => {
    expect(formatValue('unknown', 'bytes')).toBe('unknown');
    expect(formatValue(undefined, 'bytes')).toBe('');
  });
});

describe('meter layout and row conditions', () => {
  it('defaults to rows and accepts grid, ring and a row when', () => {
    const ok = validateMeters({ shape: 'bar', path: 'data.cores', item: { label: '{id}', value: '{usagePercent}' } }, 'w');
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.layout).toBe('rows');
    expect(validateMeters({ shape: 'bar', layout: 'grid', path: 'data.cores', item: { label: '{id}', value: '{usagePercent}' } }, 'w').ok).toBe(true);
    expect(validateMeters({ shape: 'ring', layout: 'grid', item: { label: '{x}', value: '{y}' } }, 'w').ok).toBe(true);
    expect(validateMeters({ shape: 'bar', layout: 'pie', item: { label: '{x}', value: '{y}' } }, 'w').ok).toBe(false);
    expect(validateMeters({ shape: 'bar', item: { label: '{x}', value: '{y}', when: { field: 'y', gt: 0 } } }, 'w').ok).toBe(true);
    expect(validateMeters({ shape: 'bar', item: { label: '{x}', value: '{y}', when: { nope: 1 } } }, 'w').ok).toBe(false);
  });

  it('leaves out the rows whose when does not hold', () => {
    const item: MeterItem = { label: '{id}', value: '{usagePercent}', when: { field: 'usagePercent', gte: 50 } };
    expect(visibleMeterRows(item, [{ id: 0, usagePercent: 10 }, { id: 1, usagePercent: 80 }])).toEqual([{ id: 1, usagePercent: 80 }]);
    expect(visibleMeterRows({ label: '{id}', value: '{usagePercent}' }, [{ id: 0 }, { id: 1 }])).toHaveLength(2);
  });
});
