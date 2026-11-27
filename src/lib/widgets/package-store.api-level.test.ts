import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/db/rqlite-client', () => ({ rqlite: {}, rowsToObjects: () => [] }));

import { installPackage } from './package-store';
import { validateManifest } from './package-manifest';

const validated = (requires: { api: number }) => {
  const v = validateManifest({
    schema: 1, id: 'alpha', name: 'Alpha', version: '1.0.0',
    widgets: [{ type: 'alpha_w', display_name: 'Alpha' }], requires,
  });
  if (!v.ok) throw new Error(v.error);
  return v.value;
};

describe('installPackage and the widget API level', () => {
  it('refuses a package that needs a newer Bosun before touching the database', async () => {
    await expect(installPackage({ manifest: validated({ api: 99 }), files: {}, source: 'upload' }))
      .rejects.toMatchObject({
        message: 'This widget needs a newer Bosun (widget API level 99; this Bosun has 8). Update Bosun first.',
        status: 422,
        code: 'NEWER_BOSUN_REQUIRED',
      });
  });
});
