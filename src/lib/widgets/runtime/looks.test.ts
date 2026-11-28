import { describe, it, expect } from 'vitest';
import { lookConfigField, lookMinSize, lookSizesProblem, readLookSize, validateLooks, withLookDefault } from './looks';

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

describe('per-look sizes', () => {
  const sized = {
    default: 'tiles',
    options: [
      { id: 'tiles', label: 'Tiles', min_size: { w: 4, h: 3 } },
      { id: 'bars', label: 'Bars', min_size: { w: 2, h: 2 }, default_size: { w: 3, h: 4 } },
    ],
  };

  it('reads a look min_size and default_size', () => {
    expect(validateLooks(sized)).toEqual({ ok: true, value: sized });
    expect(lookMinSize(sized, 'bars')).toEqual({ w: 2, h: 2 });
    expect(lookMinSize(sized, 'tiles')).toEqual({ w: 4, h: 3 });
    expect(lookMinSize(sized, 'nope')).toBeNull();
    expect(lookMinSize(sized, undefined)).toBeNull();
  });

  it('refuses a malformed size and a default smaller than the look minimum', () => {
    expect(validateLooks({ default: 'a', options: [{ id: 'a', label: 'A', min_size: { w: 0, h: 2 } }] }).ok).toBe(false);
    expect(validateLooks({ default: 'a', options: [{ id: 'a', label: 'A', min_size: { w: 2 } }] }).ok).toBe(false);
    expect(validateLooks({ default: 'a', options: [{ id: 'a', label: 'A', min_size: { w: 3, h: 3 }, default_size: { w: 2, h: 3 } }] }).ok).toBe(false);
  });

  it('refuses a size that is not a number, instead of rounding it into one', () => {
    // Number(true) is 1 and Number("8") is 8: a typo in a manifest must not become a size.
    expect(validateLooks({ default: 'a', options: [{ id: 'a', label: 'A', min_size: { w: true, h: 2 } }] }).ok).toBe(false);
    expect(validateLooks({ default: 'a', options: [{ id: 'a', label: 'A', min_size: { w: '8', h: 6 } }] }).ok).toBe(false);
    expect(validateLooks({ default: 'a', options: [{ id: 'a', label: 'A', default_size: { w: 4, h: null } }] }).ok).toBe(false);
    expect(readLookSize({ w: true, h: 2 })).toBeNull();
    expect(readLookSize({ w: 8, h: 6 })).toEqual({ w: 8, h: 6 });
  });

  it('allows a look to need more room than the widget default, but not more than its max', () => {
    expect(lookSizesProblem(sized, { w: 4, h: 3 })).toBeNull();
    expect(lookSizesProblem(sized, { w: 3, h: 3 })).toBeNull();
    expect(lookSizesProblem(sized, { w: 8, h: 6 }, { w: 2, h: 2 })).toMatch(/max_size/);
    expect(lookSizesProblem(undefined, { w: 1, h: 1 })).toBeNull();
  });

  it('exposes the sizes on the settings field', () => {
    expect(lookConfigField(sized).lookSizes).toEqual({
      tiles: { min: { w: 4, h: 3 } },
      bars: { min: { w: 2, h: 2 }, default: { w: 3, h: 4 } },
    });
    expect(lookConfigField(looks).lookSizes).toBeUndefined();
  });
});
