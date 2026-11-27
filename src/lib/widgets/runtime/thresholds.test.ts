import { describe, it, expect } from 'vitest';
import { thresholdTone, validateThresholds } from './thresholds';

describe('validateThresholds', () => {
  it('accepts high-is-bad thresholds and low-is-bad ones', () => {
    expect(validateThresholds(undefined, 'x')).toEqual({ ok: true, value: undefined });
    expect(validateThresholds({ warning: 75, danger: 90 }, 'x')).toEqual({ ok: true, value: { warning: 75, danger: 90 } });
    expect(validateThresholds({ danger: 90 }, 'x')).toEqual({ ok: true, value: { danger: 90 } });
    expect(validateThresholds({ below: { warning: 20, danger: 10 } }, 'x')).toEqual({ ok: true, value: { below: { warning: 20, danger: 10 } } });
    expect(validateThresholds({ below: { warning: 20 } }, 'x').ok).toBe(true);
  });

  it('refuses mixed meanings, unknown keys, non-numbers and the wrong order', () => {
    expect(validateThresholds({}, 'x').ok).toBe(false);
    expect(validateThresholds({ warning: 75, below: { warning: 20 } }, 'x').ok).toBe(false);
    expect(validateThresholds({ critical: 99 }, 'x').ok).toBe(false);
    expect(validateThresholds({ warning: '75' }, 'x').ok).toBe(false);
    expect(validateThresholds({ below: {} }, 'x').ok).toBe(false);
    expect(validateThresholds({ below: { critical: 1 } }, 'x').ok).toBe(false);
    expect(validateThresholds({ warning: 90, danger: 75 }, 'x').ok).toBe(false);
    expect(validateThresholds({ below: { warning: 10, danger: 20 } }, 'x').ok).toBe(false);
    expect(validateThresholds(5, 'x').ok).toBe(false);
  });
});

describe('thresholdTone', () => {
  it('treats high values as bad by default, with the boundary included', () => {
    const t = { warning: 75, danger: 90 };
    expect(thresholdTone(10, t)).toBeNull();
    expect(thresholdTone(75, t)).toBe('warning');
    expect(thresholdTone(89.9, t)).toBe('warning');
    expect(thresholdTone(90, t)).toBe('danger');
    expect(thresholdTone(200, t)).toBe('danger');
  });

  it('treats low values as bad with below', () => {
    const t = { below: { warning: 20, danger: 10 } };
    expect(thresholdTone(50, t)).toBeNull();
    expect(thresholdTone(20, t)).toBe('warning');
    expect(thresholdTone(11, t)).toBe('warning');
    expect(thresholdTone(10, t)).toBe('danger');
    expect(thresholdTone(0, t)).toBe('danger');
  });

  it('says nothing without thresholds or for a value that is not a number', () => {
    expect(thresholdTone(99, undefined)).toBeNull();
    expect(thresholdTone('n/a', { warning: 1 })).toBeNull();
    expect(thresholdTone(undefined, { warning: 1 })).toBeNull();
  });
});
