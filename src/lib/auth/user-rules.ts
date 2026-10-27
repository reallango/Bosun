/**
 * Validation and safety rules for user management (pure functions).
 */
import { isRole, type Role } from './levels';

export const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/;
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 256;

export function validateUsername(value: unknown): string | null {
  if (typeof value !== 'string' || !USERNAME_RE.test(value)) {
    return 'Username must be 2-64 characters: letters, digits, dot, dash or underscore, starting with a letter or digit';
  }
  return null;
}

export function validatePassword(value: unknown): string | null {
  if (typeof value !== 'string' || value.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  if (value.length > MAX_PASSWORD_LENGTH) return `Password must be at most ${MAX_PASSWORD_LENGTH} characters`;
  return null;
}

/** Empty/null is allowed (clears the address). */
export function validateEmail(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    return 'Invalid email address';
  }
  return null;
}

export function validateDisplayName(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > 100) return 'Display name must be at most 100 characters';
  return null;
}

export function validateRole(value: unknown): string | null {
  return isRole(value) ? null : 'Role must be viewer, operator or admin';
}

export interface UserForGuard {
  id: string;
  role: string;
  disabled: boolean;
}

export type UserChange =
  | { kind: 'delete' }
  | { kind: 'update'; role?: Role; disabled?: boolean };

/**
 * Can `actorId` apply `change` to `targetId`? Returns an error message or null.
 *
 * - nobody can delete or disable their own account, or lower their own role;
 * - the last enabled admin cannot be deleted, disabled or demoted.
 */
export function checkUserChange(users: UserForGuard[], actorId: string, targetId: string, change: UserChange): string | null {
  const target = users.find(u => u.id === targetId);
  if (!target) return 'User not found';
  const self = actorId === targetId;

  if (change.kind === 'delete') {
    if (self) return 'You cannot delete your own account';
  } else {
    if (self && change.disabled === true) return 'You cannot disable your own account';
    if (self && change.role !== undefined && change.role !== target.role) {
      return 'You cannot change your own access level; ask another admin';
    }
  }

  const targetIsActiveAdmin = target.role === 'admin' && !target.disabled;
  const removesAdmin =
    change.kind === 'delete' ||
    change.disabled === true ||
    (change.role !== undefined && change.role !== 'admin');
  if (targetIsActiveAdmin && removesAdmin) {
    const otherAdmins = users.filter(u => u.id !== targetId && u.role === 'admin' && !u.disabled).length;
    if (otherAdmins === 0) {
      return 'This is the last enabled admin. Make another user an admin first.';
    }
  }
  return null;
}
