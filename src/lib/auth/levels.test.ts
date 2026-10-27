import { describe, it, expect } from 'vitest';
import { ACCESS_LEVELS, ROLES, hasRole, isRole, minRole, roleLabel, roleRank } from './levels';

describe('access levels', () => {
  it('orders roles viewer < operator < admin', () => {
    expect(ROLES.map(roleRank)).toEqual([1, 2, 3]);
    expect(ROLES.map(r => ACCESS_LEVELS[r].level)).toEqual([1, 2, 3]);
  });

  it('labels each role', () => {
    expect(roleLabel('viewer')).toBe('Read only');
    expect(roleLabel('operator')).toBe('Read + actions');
    expect(roleLabel('admin')).toBe('Full access');
    expect(roleLabel('weird')).toBe('weird');
  });

  it('checks the hierarchy', () => {
    expect(hasRole('admin', 'operator')).toBe(true);
    expect(hasRole('operator', 'operator')).toBe(true);
    expect(hasRole('viewer', 'operator')).toBe(false);
    expect(hasRole('operator', 'admin')).toBe(false);
    expect(hasRole(undefined, 'viewer')).toBe(false);
    expect(hasRole('root', 'viewer')).toBe(false);
  });

  it('validates role values', () => {
    expect(isRole('viewer')).toBe(true);
    expect(isRole('toString')).toBe(false);
    expect(isRole(3)).toBe(false);
  });

  it('picks the lower role', () => {
    expect(minRole('admin', 'viewer')).toBe('viewer');
    expect(minRole('operator', 'admin')).toBe('operator');
  });
});
