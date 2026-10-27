import { NextRequest, NextResponse } from 'next/server';
import { clientIp, requireUserLevel } from '@/lib/auth/middleware';
import { hashPassword } from '@/lib/auth/password';
import { invalidateUserStatus } from '@/lib/auth/user-status';
import {
  checkUserChange, validateDisplayName, validateEmail, validatePassword, validateRole, type UserForGuard,
} from '@/lib/auth/user-rules';
import { USER_COLUMNS, toUserDto } from '@/lib/auth/user-dto';
import { roleLabel, type Role } from '@/lib/auth/levels';
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';
import { logAudit, AuditActions } from '@/lib/audit/logger';
import { fail, internalError, ok } from '@/lib/api/response';

type Params = { params: Promise<{ userId: string }> };

async function loadGuardUsers(): Promise<(UserForGuard & { username: string })[]> {
  const r = await rqlite.query('SELECT id, username, role, disabled FROM users');
  return (r.values || []).map(([id, username, role, disabled]) => ({
    id: String(id), username: String(username), role: String(role), disabled: Number(disabled) === 1,
  }));
}

/**
 * Update a user (Full access, signed-in users only):
 * { display_name?, email?, role?, disabled?, password? }.
 * Disabling a user or setting a new password ends all of their sessions.
 */
export async function PATCH(request: NextRequest, { params }: Params) {
  const auth = await requireUserLevel(request, 'admin');
  if (auth instanceof NextResponse) return auth;
  const { userId } = await params;

  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return fail('Invalid JSON body'); }

  const sets: string[] = [];
  const values: unknown[] = [];
  const notes: string[] = [];

  if (body.display_name !== undefined) {
    const v = typeof body.display_name === 'string' ? body.display_name.trim() : body.display_name;
    const err = validateDisplayName(v);
    if (err) return fail(err, 400, 'VALIDATION');
    sets.push('display_name = ?'); values.push(v || null); notes.push('display name');
  }
  if (body.email !== undefined) {
    const v = typeof body.email === 'string' ? body.email.trim() : body.email;
    const err = validateEmail(v);
    if (err) return fail(err, 400, 'VALIDATION');
    sets.push('email = ?'); values.push(v || null); notes.push('email');
  }
  let role: Role | undefined;
  if (body.role !== undefined) {
    const err = validateRole(body.role);
    if (err) return fail(err, 400, 'VALIDATION');
    role = body.role as Role;
  }
  let disabled: boolean | undefined;
  if (body.disabled !== undefined) {
    if (typeof body.disabled !== 'boolean') return fail('disabled must be true or false', 400, 'VALIDATION');
    disabled = body.disabled;
  }
  let passwordHash: string | undefined;
  if (body.password !== undefined) {
    const err = validatePassword(body.password);
    if (err) return fail(err, 400, 'VALIDATION');
    passwordHash = await hashPassword(body.password as string);
  }

  try {
    const users = await loadGuardUsers();
    const target = users.find(u => u.id === userId);
    if (!target) return fail('User not found', 404, 'NOT_FOUND');
    const guard = checkUserChange(users, auth.userId, userId, { kind: 'update', role, disabled });
    if (guard) return fail(guard, 409, 'NOT_ALLOWED');

    const roleChanged = role !== undefined && role !== target.role;
    const disabledChanged = disabled !== undefined && disabled !== target.disabled;
    if (roleChanged) { sets.push('role = ?'); values.push(role); }
    if (disabledChanged) { sets.push('disabled = ?'); values.push(disabled ? 1 : 0); }
    if (passwordHash) {
      sets.push('password_hash = ?', 'password_changed_at = ?');
      values.push(passwordHash, new Date().toISOString());
    }
    if (!sets.length) return fail('Nothing to update', 400, 'NOTHING_TO_UPDATE');

    sets.push('updated_at = CURRENT_TIMESTAMP');
    const stmts: { sql: string; params: unknown[] }[] = [
      { sql: `UPDATE users SET ${sets.join(', ')} WHERE id = ?`, params: [...values, userId] },
    ];
    // Force re-login: refresh tokens die now; access tokens within 15 minutes
    // (requireAuth refuses disabled users within ~30 s).
    const endSessions = (disabledChanged && disabled) || !!passwordHash;
    if (endSessions) stmts.push({ sql: 'DELETE FROM sessions WHERE user_id = ?', params: [userId] });
    await rqlite.executeBatch(stmts, { transaction: true });
    invalidateUserStatus();

    const ip = clientIp(request) ?? undefined;
    const audit = (action: string, details: string) =>
      logAudit({ userId: auth.userId, action, category: 'user', status: 'success', details, ipAddress: ip });
    if (notes.length || roleChanged) {
      const parts = [...notes];
      if (roleChanged) parts.push(`access level ${roleLabel(target.role)} -> ${roleLabel(role)}`);
      await audit(AuditActions.USER_UPDATE, `${target.username}: ${parts.join(', ')}`);
    }
    if (disabledChanged) await audit(disabled ? AuditActions.USER_DISABLE : AuditActions.USER_ENABLE, target.username);
    if (passwordHash) await audit(AuditActions.USER_PASSWORD_RESET, `${target.username}: password set by admin`);

    const r = await rqlite.query(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`, [userId]);
    return ok({ user: toUserDto(rowsToObjects(r)[0]), sessionsEnded: endSessions });
  } catch (error) {
    console.error('User update error:', error);
    return internalError(error);
  }
}

/** Delete a user (Full access). Not yourself, not the last enabled admin. */
export async function DELETE(request: NextRequest, { params }: Params) {
  const auth = await requireUserLevel(request, 'admin');
  if (auth instanceof NextResponse) return auth;
  const { userId } = await params;
  try {
    const users = await loadGuardUsers();
    const target = users.find(u => u.id === userId);
    if (!target) return fail('User not found', 404, 'NOT_FOUND');
    const guard = checkUserChange(users, auth.userId, userId, { kind: 'delete' });
    if (guard) return fail(guard, 409, 'NOT_ALLOWED');

    // Explicit cleanup: does not rely on SQLite foreign-key enforcement.
    await rqlite.executeBatch([
      { sql: 'DELETE FROM sessions WHERE user_id = ?', params: [userId] },
      { sql: 'DELETE FROM password_resets WHERE user_id = ?', params: [userId] },
      { sql: 'DELETE FROM mfa_challenges WHERE user_id = ?', params: [userId] },
      { sql: 'UPDATE api_keys SET created_by = NULL WHERE created_by = ?', params: [userId] },
      { sql: 'DELETE FROM users WHERE id = ?', params: [userId] },
    ], { transaction: true });
    invalidateUserStatus();
    await logAudit({
      userId: auth.userId, action: AuditActions.USER_DELETE, category: 'user', status: 'success',
      details: `Deleted ${target.username} (${roleLabel(target.role)})`, ipAddress: clientIp(request) ?? undefined,
    });
    return ok({ success: true });
  } catch (error) {
    console.error('User delete error:', error);
    return internalError(error);
  }
}
