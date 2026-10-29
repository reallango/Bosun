import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { bundledIds, readBundledPackages } from './bundled';

const root = path.join(process.cwd(), 'widgets');

describe('bundled packages', () => {
  it('lists packages that exist, validate and are never system widgets', () => {
    const ids = bundledIds(root);
    expect(ids.length).toBeGreaterThan(0);
    const { packages, errors } = readBundledPackages(root);
    expect(errors).toEqual([]);
    expect(packages.map(p => p.manifest.id).sort()).toEqual([...ids].sort());
  });

  it('only lists folders of this repository', () => {
    for (const id of bundledIds(root)) expect(fs.existsSync(path.join(root, id, 'manifest.json'))).toBe(true);
  });

  it('gives every bundled widget a data permission everybody holds (so Read only users still see dashboards)', () => {
    for (const { manifest } of readBundledPackages(root).packages) {
      for (const w of manifest.widgets) {
        const perm = manifest.permissions.find(p => p.id === w.spec?.data.permission);
        expect(perm?.defaultLevel, `${manifest.id}/${w.type}`).toBe('viewer');
      }
    }
  });
});
