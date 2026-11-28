import { describe, it, expect } from 'vitest';
import { gaugeGeometry, gaugeItemsFromRows, gaugeStroke, GAUGE_STROKE, validateGaugeItem } from './gauges';

describe('validateGaugeItem', () => {
  it('accepts a label, a value template and the optional keys', () => {
    expect(validateGaugeItem({ label: 'CPU', value: '{cpu.usagePercent}' }, 'x')).toEqual({
      ok: true, value: { label: 'CPU', value: '{cpu.usagePercent}' },
    });
    expect(validateGaugeItem({ label: 'CPU', value: '{v}', max: 10, unit: '%', sub: '8 cores', thresholds: { warning: 75 } }, 'x')).toEqual({
      ok: true,
      value: { label: 'CPU', value: '{v}', max: 10, unit: '%', sub: '8 cores', thresholds: { warning: 75 } },
    });
  });

  it('refuses a missing label or value, a max that is not above 0 and malformed options', () => {
    expect(validateGaugeItem({ value: '{v}' }, 'x').ok).toBe(false);
    expect(validateGaugeItem({ label: 'CPU' }, 'x').ok).toBe(false);
    expect(validateGaugeItem({ label: 'CPU', value: '{v}', max: 0 }, 'x').ok).toBe(false);
    expect(validateGaugeItem({ label: 'CPU', value: '{v}', max: -5 }, 'x').ok).toBe(false);
    expect(validateGaugeItem({ label: 'CPU', value: '{v}', unit: '123456789' }, 'x').ok).toBe(false);
    expect(validateGaugeItem({ label: 'CPU', value: '{v}', thresholds: { warning: 90, danger: 75 } }, 'x').ok).toBe(false);
    expect(validateGaugeItem('CPU', 'x').ok).toBe(false);
  });
});

describe('gaugeGeometry', () => {
  it('fills the ring in proportion to max', () => {
    const half = gaugeGeometry(50, 100);
    expect(half.pct).toBe(50);
    expect(half.cx).toBe(50);
    expect(half.cy).toBe(50);
    expect(half.r).toBe(45);
    expect(half.circumference).toBeCloseTo(2 * Math.PI * 45);
    expect(half.dashOffset).toBeCloseTo(half.circumference / 2);
  });

  it('clamps values outside 0-max and an unknown value', () => {
    expect(gaugeGeometry(-10, 100).pct).toBe(0);
    expect(gaugeGeometry(200, 100).pct).toBe(100);
    expect(gaugeGeometry(5, 10).pct).toBe(50);
    expect(gaugeGeometry(Number.NaN, 100).pct).toBe(0);
    expect(gaugeGeometry(5, 0).pct).toBe(0);
  });

  it('scales with the ring size', () => {
    const small = gaugeGeometry(25, 100, 100, 10);
    const large = gaugeGeometry(25, 100, 200, 20);
    expect(large.r).toBe(90);
    expect(large.circumference).toBeCloseTo(2 * Math.PI * 90);
    expect(large.dashOffset / large.circumference).toBeCloseTo(small.dashOffset / small.circumference);
  });
});

describe('validateGaugeItem sizing keys', () => {
  it('keeps decimals, emphasis and thickness', () => {
    expect(validateGaugeItem({ label: 'CPU', value: '{v}', decimals: 2, emphasis: 'muted', thickness: 'thin' }, 'x')).toEqual({
      ok: true, value: { label: 'CPU', value: '{v}', decimals: 2, emphasis: 'muted', thickness: 'thin' },
    });
  });

  it('refuses an unknown decimals, emphasis or thickness', () => {
    expect(validateGaugeItem({ label: 'CPU', value: '{v}', decimals: 4 }, 'x').ok).toBe(false);
    expect(validateGaugeItem({ label: 'CPU', value: '{v}', emphasis: 'loud' }, 'x').ok).toBe(false);
    expect(validateGaugeItem({ label: 'CPU', value: '{v}', thickness: 'wide' }, 'x').ok).toBe(false);
  });
});

describe('gaugeItemsFromRows', () => {
  const item = { label: '{mountPoint}', value: '{usagePercent}', max: 100, unit: '%', sub: '{filesystem}', thresholds: { warning: 80 } };

  it('fills the templates from each row, keeping the item options', () => {
    expect(gaugeItemsFromRows(item, [
      { mountPoint: '/', usagePercent: 42, filesystem: '/dev/sda1' },
      { mountPoint: '/data', usagePercent: 91, filesystem: '/dev/sdb1' },
    ])).toEqual([
      { label: '/', value: '42', max: 100, unit: '%', sub: '/dev/sda1', thresholds: { warning: 80 } },
      { label: '/data', value: '91', max: 100, unit: '%', sub: '/dev/sdb1', thresholds: { warning: 80 } },
    ]);
  });

  it('reads the item when against the row, and falls through its alternatives', () => {
    const g = { ...item, when: { field: 'usagePercent', gte: 90 }, alternatives: [{ label: '{mountPoint}', value: '{usagePercent}', sub: 'low' }] };
    expect(gaugeItemsFromRows(g, [{ mountPoint: '/', usagePercent: 42 }, { mountPoint: '/data', usagePercent: 91 }]).map(x => x.label)).toEqual(['/', '/data']);
    expect(gaugeItemsFromRows(g, [{ mountPoint: '/', usagePercent: 42 }])[0].sub).toBe('low');
    expect(gaugeItemsFromRows({ ...item, when: { field: 'usagePercent', gte: 90 } }, [{ mountPoint: '/', usagePercent: 42 }])).toEqual([]);
  });

  it('takes one object as one row and nothing as no rows', () => {
    expect(gaugeItemsFromRows(item, { mountPoint: '/', usagePercent: 7 })).toHaveLength(1);
    expect(gaugeItemsFromRows(item, undefined)).toEqual([]);
  });
});

describe('gaugeStroke', () => {
  it('maps the named thicknesses and defaults to normal', () => {
    expect(gaugeStroke(undefined)).toBe(GAUGE_STROKE);
    expect(gaugeStroke('thin')).toBeLessThan(GAUGE_STROKE);
    expect(gaugeStroke('thick')).toBeGreaterThan(GAUGE_STROKE);
  });
});
