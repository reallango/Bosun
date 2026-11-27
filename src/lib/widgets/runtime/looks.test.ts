import { describe, it, expect } from 'vitest';
import { lookConfigField, validateLooks, withLookDefault } from './looks';

const looks = {
  default: 'tiles',
  options: [{ id: 'tiles', label: 'Tiles' }, { id: 'gauges', label: 'Gauges' }],
};

describe('validateLooks', () => {
  it('accepts a default that names one of the looks', () => {
    expect(validateLooks(looks)).toEqual({ ok: true, value: looks });
    expect(validateLooks({ default: 'a', options: [{ id: 'a', label: 'A' }] }).ok).toBe(true);
  });

  it('refuses a missing or malformed list, duplicate ids and a default that is not there', () => {
    expect(validateLooks(undefined).ok).toBe(false);
    expect(validateLooks({}).ok).toBe(false);
    expect(validateLooks({ default: 'a', options: [] }).ok).toBe(false);
    expect(validateLooks({ default: 'a', options: Array.from({ length: 7 }, (_, i) => ({ id: `l${i}`, label: `L${i}` })) }).ok).toBe(false);
    expect(validateLooks({ default: 'a', options: [{ id: 'A', label: 'A' }] }).ok).toBe(false);
    expect(validateLooks({ default: 'a', options: [{ id: 'a' }] }).ok).toBe(false);
    expect(validateLooks({ default: 'a', options: [{ id: 'a', label: 'A' }, { id: 'a', label: 'Again' }] }).ok).toBe(false);
    expect(validateLooks({ default: 'b', options: [{ id: 'a', label: 'A' }] }).ok).toBe(false);
  });
});

describe('lookConfigField', () => {
  it('is the select the settings dialog shows, with the labels of the looks', () => {
    const field = lookConfigField(looks);
    expect(field).toMatchObject({
      key: 'look', label: 'Look', type: 'select', options: ['tiles', 'gauges'],
      optionLabels: { tiles: 'Tiles', gauges: 'Gauges' }, default: 'tiles',
    });
  });
});

describe('withLookDefault', () => {
  it('fills in the default look without overwriting a saved one', () => {
    expect(withLookDefault(looks, undefined)).toEqual({ look: 'tiles' });
    expect(withLookDefault(looks, { look: 'gauges', other: 1 })).toEqual({ look: 'gauges', other: 1 });
  });

  it('falls back to the default when the saved look is empty or no longer offered', () => {
    expect(withLookDefault(looks, { look: '' })).toEqual({ look: 'tiles' });
    expect(withLookDefault(looks, { look: 'old' })).toEqual({ look: 'tiles' });
  });

  it('leaves a widget without looks alone', () => {
    expect(withLookDefault(undefined, { x: 1 })).toEqual({ x: 1 });
    expect(withLookDefault(undefined, undefined)).toEqual({});
  });
});
