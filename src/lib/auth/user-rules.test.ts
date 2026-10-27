import { describe, it, expect } from 'vitest';
import { checkUserChange, validateEmail, validatePassword, validateRole, validateUsername, type UserForGuard } from './user-rules';

const users: UserForGuard[] = [
  { id: 'a1', role: 'admin', disabled: false },
  { id: 'a2', role: 'admin', disabled: true },
  { id: 'o1', role: 'operator', disabled: false },
];

describe('checkUserChange', () => {
  it('refuses self-delete, self-disable and self-demotion', () => {
    expect(checkUserChange(users, 'o1', 'o1', { kind: 'delete' })).toMatch(/own account/);
    expect(checkUserChange(users, 'o1', 'o1', { kind: 'update', disabled: true })).toMatch(/own account/);
    expect(checkUserChange(users, 'a1', 'a1', { kind: 'update', role: 'viewer' })).toMatch(/own access level/);
  });

  it('allows harmless self updates', () => {
    expect(checkUserChange(users, 'a1', 'a1', { kind: 'update', role: 'admin', disabled: false })).toBeNull();
    expect(checkUserChange(users, 'a1', 'a1', { kind: 'update' })).toBeNull();
  });

  it('protects the last enabled admin', () => {
    // a2 is disabled, so a1 is the only enabled admin.
    expect(checkUserChange(users, 'x', 'a1', { kind: 'delete' })).toMatch(/last enabled admin/);
    expect(checkUserChange(users, 'x', 'a1', { kind: 'update', disabled: true })).toMatch(/last enabled admin/);
    expect(checkUserChange(users, 'x', 'a1', { kind: 'update', role: 'operator' })).toMatch(/last enabled admin/);
  });

  it('allows removing an admin when another enabled admin remains', () => {
    const more = [...users, { id: 'a3', role: 'admin', disabled: false }];
    expect(checkUserChange(more, 'a3', 'a1', { kind: 'delete' })).toBeNull();
    expect(checkUserChange(more, 'a3', 'a1', { kind: 'update', role: 'viewer' })).toBeNull();
  });

  it('does not block changes to disabled admins or non-admins', () => {
    expect(checkUserChange(users, 'a1', 'a2', { kind: 'delete' })).toBeNull();
    expect(checkUserChange(users, 'a1', 'o1', { kind: 'update', disabled: true })).toBeNull();
    expect(checkUserChange(users, 'a1', 'o1', { kind: 'update', role: 'admin' })).toBeNull();
  });

  it('reports unknown users', () => {
    expect(checkUserChange(users, 'a1', 'nope', { kind: 'delete' })).toBe('User not found');
  });
});

describe('validators', () => {
  it('validates usernames', () => {
    expect(validateUsername('alice')).toBeNull();
    expect(validateUsername('a.b-c_1')).toBeNull();
    expect(validateUsername('a')).not.toBeNull();
    expect(validateUsername('-alice')).not.toBeNull();
    expect(validateUsername('al ice')).not.toBeNull();
    expect(validateUsername(undefined)).not.toBeNull();
  });

  it('validates passwords', () => {
    expect(validatePassword('12345678')).toBeNull();
    expect(validatePassword('1234567')).not.toBeNull();
    expect(validatePassword(12345678)).not.toBeNull();
    expect(validatePassword('x'.repeat(300))).not.toBeNull();
  });

  it('validates emails and roles', () => {
    expect(validateEmail('')).toBeNull();
    expect(validateEmail('a@b.co')).toBeNull();
    expect(validateEmail('nope')).not.toBeNull();
    expect(validateRole('operator')).toBeNull();
    expect(validateRole('root')).not.toBeNull();
  });
});
