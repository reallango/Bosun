import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/db/rqlite-client', () => ({ rqlite: {}, rowsToObjects: () => [] }));

import { redactParams } from './store';

describe('redactParams (job records and the audit log)', () => {
  it('keeps plain values, replaces text by its size, and masks secret-looking names and NAME=value pairs', () => {
    expect(redactParams({
      name: 'web',
      lines: 200,
      volumes: true,
      yaml: 'services:\n  db:\n    environment:\n      DB_PASSWORD: hunter2\n',
      password: 'hunter2',
      api_key: '',
      env: 'DB_PASSWORD=hunter2',
      label: 'MODE=prod',
      list: ['TOKEN=abc', 'x'],
    })).toEqual({
      name: 'web',
      lines: 200,
      volumes: true,
      yaml: '(60 characters)',
      password: '***',
      api_key: '',
      env: 'DB_PASSWORD=***',
      label: 'MODE=prod',
      list: ['TOKEN=***', 'x'],
    });
  });

  it('accepts anything as input', () => {
    expect(redactParams(undefined)).toEqual({});
    expect(redactParams('x')).toEqual({});
    expect(redactParams([1])).toEqual({});
  });
});
