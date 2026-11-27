import { describe, it, expect } from 'vitest';
import { seedDecision } from './bundled-seed';

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
