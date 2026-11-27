import { describe, it, expect } from 'vitest';
import { statTone, withUnit } from './stat';

const ctx = { data: { stopped: 3, cache: '12GB' }, state: { running: 0 } };

describe('statTone', () => {
  it('uses a fixed tone as it is', () => {
    expect(statTone('warning', ctx)).toBe('warning');
    expect(statTone('danger', ctx)).toBe('danger');
    expect(statTone('success', ctx)).toBe('success');
    expect(statTone(undefined, ctx)).toBeNull();
  });

  it('picks the first tone whose condition holds, in the order written', () => {
    expect(statTone({ warning: { field: 'data.stopped', gt: 0 } }, ctx)).toBe('warning');
    expect(statTone({ warning: { field: 'data.stopped', gt: 5 } }, ctx)).toBeNull();
    expect(statTone({ success: { field: 'data.stopped', equals: 0 }, danger: { field: 'data.stopped', gt: 0 } }, ctx)).toBe('danger');
    expect(statTone({ danger: { field: 'data.stopped', gt: 10 }, warning: { field: 'data.stopped', gt: 0 } }, ctx)).toBe('warning');
  });

  it('reads paths in the context, including nested state and equality', () => {
    expect(statTone({ success: { field: 'state.running', equals: 0 } }, ctx)).toBe('success');
    expect(statTone({ warning: { field: 'data.cache', equals: '12GB' } }, ctx)).toBe('warning');
  });
});

describe('withUnit', () => {
  it('keeps percent and temperature tight and gives other units a space', () => {
    expect(withUnit('82', '%')).toBe('82%');
    expect(withUnit('61', '°C')).toBe('61°C');
    expect(withUnit('128', 'MB')).toBe('128 MB');
    expect(withUnit('', '%')).toBe('');
    expect(withUnit('82', undefined)).toBe('82');
  });
});
