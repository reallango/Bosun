import { describe, it, expect, vi, beforeEach } from 'vitest';

const execute = vi.fn();
const query = vi.fn();
vi.mock('@/lib/db/rqlite-client', () => ({
  rqlite: { execute: (...a: unknown[]) => execute(...a), query: (...a: unknown[]) => query(...a) },
  rowsToObjects: (r: { columns: string[]; values: unknown[][] }) =>
    (r.values ?? []).map(v => Object.fromEntries(r.columns.map((c, i) => [c, v[i]]))),
}));
vi.mock('@/lib/permissions/effective', () => ({ serverVisible: async () => true }));

import { pendingUpdates, announceUpdates, announceInstalled, updateKeyPrefix } from './update-check';
import { safeLink, toDto, audienceAllows } from '@/lib/notifications/store';

beforeEach(() => {
  execute.mockReset().mockResolvedValue({ rows_affected: 1 });
  query.mockReset().mockResolvedValue({ columns: ['username'], values: [['alice']] });
});

describe('pendingUpdates', () => {
  it('lists only installed packages with a newer remote version', () => {
    const out = pendingUpdates(
      [{ id: 'docker', name: 'Docker', version: '1.0.7' }, { id: 'ollama', name: 'Ollama', version: '2.0.0' }, { id: 'local', name: 'Local', version: '1.0.0' }],
      [{ id: 'docker', name: 'Docker', version: '1.0.10' }, { id: 'ollama', name: 'Ollama', version: '2.0.0' }, { id: 'new', name: 'New', version: '1.0.0' }],
    );
    expect(out).toEqual([{ id: 'docker', name: 'Docker', installed: '1.0.7', available: '1.0.10' }]);
  });
});

describe('announceUpdates', () => {
  it('raises one admin-only notice per package and version, keyed for dedupe', async () => {
    const n = await announceUpdates([{ id: 'docker', name: 'Docker', installed: '1.0.7', available: '1.0.8' }], 'main');
    expect(n).toBe(1);
    const [sql, params] = execute.mock.calls[0];
    expect(sql).toMatch(/^INSERT OR IGNORE INTO notifications/);
    expect(params).toContain('widget_update');
    expect(params).toContain(`${updateKeyPrefix('docker')}1.0.8`);
    expect(params).toContain('admin');
    expect(params).toContain('/settings/widgets');
  });

  it('counts a repeat (dedupe hit) as not new', async () => {
    execute.mockResolvedValue({ rows_affected: 0 });
    expect(await announceUpdates([{ id: 'docker', name: 'Docker', installed: '1.0.7', available: '1.0.8' }], 'main')).toBe(0);
  });
});

describe('announceInstalled', () => {
  it('closes open update notices and announces an upgrade with who did it', async () => {
    await announceInstalled({ id: 'docker', name: 'Docker', version: '1.0.8', previousVersion: '1.0.7', source: 'github', userId: 'u1' });
    expect(execute.mock.calls[0][0]).toMatch(/^UPDATE notifications SET is_read = 1, is_dismissed = 1/);
    expect(execute.mock.calls[0][1]).toEqual(['widget-update:docker:%']);
    const params = execute.mock.calls[1][1] as unknown[];
    expect(params).toContain('Docker upgraded to 1.0.8');
    expect(params.some(p => typeof p === 'string' && p.includes('1.0.7 → 1.0.8 from GitHub, by alice'))).toBe(true);
  });

  it('says a bundled upgrade happened automatically', async () => {
    await announceInstalled({ id: 'docker', name: 'Docker', version: '1.0.8', previousVersion: '1.0.7', source: 'bundled' });
    const params = execute.mock.calls[1][1] as unknown[];
    expect(params.some(p => typeof p === 'string' && p.includes('automatically'))).toBe(true);
  });

  it('stays quiet for the first install of bundled packages and for a same-version re-import', async () => {
    await announceInstalled({ id: 'docker', name: 'Docker', version: '1.0.8', previousVersion: null, source: 'bundled' });
    await announceInstalled({ id: 'docker', name: 'Docker', version: '1.0.8', previousVersion: '1.0.8', source: 'upload' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('never throws when the database fails', async () => {
    execute.mockRejectedValue(new Error('down'));
    await expect(announceInstalled({ id: 'd', name: 'D', version: '2', previousVersion: '1', source: 'upload' })).resolves.toBeUndefined();
  });
});

describe('notification helpers', () => {
  it('only keeps in-app links', () => {
    expect(safeLink('/settings/widgets')).toBe('/settings/widgets');
    expect(safeLink('/servers/abc?tab=docker')).toBe('/servers/abc?tab=docker');
    expect(safeLink('//evil.example/x')).toBeNull();
    expect(safeLink('/\\evil.example')).toBeNull();
    expect(safeLink('https://evil.example')).toBeNull();
    expect(safeLink('javascript:alert(1)')).toBeNull();
    expect(safeLink(null)).toBeNull();
  });

  it('maps rows to what the bell shows', () => {
    expect(toDto({ id: 'n1', severity: 'critical', title: 't', message: 'm', is_read: 0, created_at: 'x', link: '//bad' }))
      .toMatchObject({ id: 'n1', kind: 'alert', type: 'error', read: false, link: null });
    expect(toDto({ id: 'n2', kind: 'widget_upgraded', severity: 'success', is_read: 1 })).toMatchObject({ type: 'success', read: true });
  });

  it('limits audiences by access level', () => {
    expect(audienceAllows('viewer', null)).toBe(true);
    expect(audienceAllows('viewer', 'admin')).toBe(false);
    expect(audienceAllows('operator', 'operator')).toBe(true);
    expect(audienceAllows('admin', 'admin')).toBe(true);
  });
});
