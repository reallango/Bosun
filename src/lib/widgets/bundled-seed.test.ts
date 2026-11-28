import { describe, it, expect } from 'vitest';
import fs from 'fs';
import { seedDecision, seedManifestChanged } from './bundled-seed';
import { validateManifest, type PackageManifest } from './package-manifest';

describe('seedDecision', () => {
  it('installs a bundled package that is not installed', () => {
    expect(seedDecision('1.2.0', null, false)).toBe('install');
  });

  it('upgrades a bundled package from an older version', () => {
    expect(seedDecision('1.2.0', { source: 'bundled', version: '1.1.0' }, false)).toBe('upgrade');
  });

  it('upgrades a GitHub install from an older version (same repository, secrets are kept)', () => {
    expect(seedDecision('1.2.0', { source: 'github', version: '1.1.0' }, false)).toBe('upgrade');
  });

  it('leaves a GitHub install alone at the same or a higher version', () => {
    expect(seedDecision('1.2.0', { source: 'github', version: '1.2.0' }, false)).toBe('skip');
    expect(seedDecision('1.2.0', { source: 'github', version: '1.3.0' }, false)).toBe('skip');
  });

  it('never reinstalls the same version or downgrades a bundled package', () => {
    expect(seedDecision('1.2.0', { source: 'bundled', version: '1.2.0' }, false)).toBe('skip');
    expect(seedDecision('1.2.0', { source: 'bundled', version: '1.3.0' }, false)).toBe('skip');
  });

  it('never touches a zip upload, even when the image ships a newer version', () => {
    expect(seedDecision('1.2.0', { source: 'upload', version: '1.1.0' }, false)).toBe('skip');
  });

  it('does not bring back a removed bundled package', () => {
    expect(seedDecision('1.2.0', null, true)).toBe('skip');
    expect(seedDecision('1.2.0', { source: 'bundled', version: '1.1.0' }, true)).toBe('skip');
  });
});

describe('seedDecision and the cluster minimum', () => {
  it('defers a version that needs an API level above the lowest voter', () => {
    expect(seedDecision('1.0.28', { source: 'bundled', version: '1.0.27' }, false, { minimum: 8, requiresApi: 9 })).toBe('defer');
    expect(seedDecision('1.0.28', null, false, { minimum: 8, requiresApi: 9 })).toBe('defer');
  });

  it('defers when a voter’s level is unknown', () => {
    expect(seedDecision('1.0.28', { source: 'bundled', version: '1.0.27' }, false, { minimum: null, requiresApi: 9 })).toBe('defer');
  });

  it('installs or upgrades once every voter is at the level', () => {
    expect(seedDecision('1.0.28', null, false, { minimum: 9, requiresApi: 9 })).toBe('install');
    expect(seedDecision('1.0.28', { source: 'bundled', version: '1.0.27' }, false, { minimum: 9, requiresApi: 9 })).toBe('upgrade');
  });

  it('behaves as before for a package that needs level 1, even with an unknown node', () => {
    expect(seedDecision('1.2.0', null, false, { minimum: null, requiresApi: 1 })).toBe('install');
  });

  it('never resurrects a removed package or touches an upload just because the cluster is ready', () => {
    expect(seedDecision('1.2.0', null, true, { minimum: 9, requiresApi: 9 })).toBe('skip');
    expect(seedDecision('1.2.0', { source: 'upload', version: '1.0.0' }, false, { minimum: 9, requiresApi: 9 })).toBe('skip');
  });

  it('is not deferred when nothing would be written anyway', () => {
    expect(seedDecision('1.2.0', { source: 'bundled', version: '1.2.0' }, false, { minimum: 8, requiresApi: 9 })).toBe('skip');
  });
});

/** The Docker package's real manifest, optionally without the credential kinds' view_permission (an older build). */
const dockerManifest = (withViewPermission: boolean): PackageManifest => {
  const raw = JSON.parse(fs.readFileSync('widgets/docker/manifest.json', 'utf8'));
  if (!withViewPermission) for (const c of raw.credentials) delete c.view_permission;
  const v = validateManifest(raw);
  if (!v.ok) throw new Error(v.error);
  return v.value;
};

describe('seedManifestChanged', () => {
  const bundled = dockerManifest(true);
  const installedOlder = { version: bundled.version, source: 'github', manifest: dockerManifest(false) };

  it('refreshes the same version when the installed manifest is older than the image\'s copy', () => {
    expect(seedManifestChanged(bundled, installedOlder)).toBe(true);
    expect(seedManifestChanged(bundled, { ...installedOlder, source: 'bundled' })).toBe(true);
  });

  it('leaves an identical manifest, another version and a zip upload alone', () => {
    expect(seedManifestChanged(bundled, { ...installedOlder, manifest: dockerManifest(true) })).toBe(false);
    expect(seedManifestChanged(bundled, { ...installedOlder, version: '9.9.9' })).toBe(false);
    expect(seedManifestChanged(bundled, { ...installedOlder, version: '0.0.1' })).toBe(false);
    expect(seedManifestChanged(bundled, { ...installedOlder, source: 'upload' })).toBe(false);
    expect(seedManifestChanged(bundled, null)).toBe(false);
  });
});
