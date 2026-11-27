import { describe, it, expect } from 'vitest';
import { sanitizeCustomWidget } from './custom-widget-input';

describe('sanitizeCustomWidget', () => {
  it('requires a display name when creating', () => {
    expect(sanitizeCustomWidget({}, true)).toEqual({ error: expect.stringMatching(/display_name/) });
    expect(sanitizeCustomWidget({}, false)).toEqual({ values: {} });
  });
  it('serialises sizes, schema and booleans', () => {
    const r = sanitizeCustomWidget({
      display_name: ' Ollama ', default_size: { w: 8.4, h: 6 }, supports_windows: false, enabled: true,
      config_schema: [{ key: 'filter', label: 'Show', type: 'select', options: ['a', 'b'], default: 'a' }],
    }, true);
    expect(r).toEqual({ values: {
      display_name: 'Ollama', default_size: '{"w":8,"h":6}', supports_windows: 0, enabled: 1,
      config_schema: '[{"key":"filter","label":"Show","type":"select","default":"a","options":["a","b"]}]',
    } });
  });
  it('serialises max_size and phone_height', () => {
    const r = sanitizeCustomWidget({
      display_name: 'Chart', default_size: { w: 6, h: 4 }, min_size: { w: 3, h: 2 },
      max_size: { w: 12, h: 8 }, phone_height: 6,
    }, true);
    expect(r).toEqual({ values: {
      display_name: 'Chart', default_size: '{"w":6,"h":4}', min_size: '{"w":3,"h":2}',
      max_size: '{"w":12,"h":8}', phone_height: 6,
    } });
  });
  it('rejects bad input', () => {
    expect('error' in sanitizeCustomWidget({ default_size: { w: 99, h: 1 } }, false)).toBe(true);
    expect('error' in sanitizeCustomWidget({ config_schema: [{ key: '1bad', type: 'string' }] }, false)).toBe(true);
    expect('error' in sanitizeCustomWidget({ config_schema: [{ key: 'x', type: 'script' }] }, false)).toBe(true);
    expect('error' in sanitizeCustomWidget({ category: 'evil' }, false)).toBe(true);
    expect('error' in sanitizeCustomWidget({ supports_linux: false, supports_windows: false }, false)).toBe(true);
    expect('error' in sanitizeCustomWidget({ refresh_interval: 1 }, false)).toBe(true);
    expect('error' in sanitizeCustomWidget({ default_size: { w: 8, h: 6 }, max_size: { w: 7, h: 6 } }, false)).toBe(true);
    expect('error' in sanitizeCustomWidget({ display_name: 'X', max_size: { w: 7, h: 6 } }, true)).toBe(true);
    expect('error' in sanitizeCustomWidget({ phone_height: 0 }, false)).toBe(true);
    expect('error' in sanitizeCustomWidget({ phone_height: 49 }, false)).toBe(true);
  });
});
