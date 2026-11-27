import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/db/initialize', () => ({ ensureDatabase: async () => undefined }));
vi.mock('@/lib/db/rqlite-client', () => ({ rqlite: { isReady: async () => true } }));
vi.mock('@/lib/update/version', () => ({ bosunVersion: () => ({ commit: 'abcdef0', short: 'abcdef0', channel: 'dev' }) }));

import { GET } from './route';
import { WIDGET_API_LEVEL } from '@/lib/widgets/api-level';

describe('GET /api/health', () => {
  it('reports the widget API level next to the version', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      status: 'ok',
      leader: true,
      version: { commit: 'abcdef0', short: 'abcdef0', channel: 'dev' },
      widget_api_level: WIDGET_API_LEVEL,
    });
    expect(body.widget_api_level).toBe(10);
    expect(typeof body.timestamp).toBe('string');
  });
});
