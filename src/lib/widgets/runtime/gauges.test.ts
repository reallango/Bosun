import { describe, it, expect } from 'vitest';
import { gaugeGeometry, validateGaugeItem } from './gauges';

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
