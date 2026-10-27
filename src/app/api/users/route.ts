import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { clientIp, requireUserLevel } from '@/lib/auth/middleware';
import { hashPassword } from '@/lib/auth/password';
import { invalidateUserStatus } from '@/lib/auth/user-status';
import { validateDisplayName, validateEmail, validatePassword, validateRole, validateUsername } from '@/lib/auth/user-rules';
import { roleLabel } from '@/lib/auth/levels';
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';
import { logAudit, AuditActions } from '@/lib/audit/logger';
import { fail, internalError, ok } from '@/lib/api/response';
import { USER_COLUMNS, toUserDto } from '@/lib/auth/user-dto';

/** List users. Full access, signed-in users only (no API keys). */
export async function GET(request: NextRequest) {
  const auth = await requireUserLevel(request, 'admin');
  if (auth instanceof NextResponse) return auth;
  try {
    const r = await rqlite.query(`SELECT ${USER_COLUMNS} FROM users ORDER BY username COLLATE NOCASE`);
    return ok({ users: rowsToObjects(r).map(toUserDto) });
  } catch (error) {
    console.error('Users list error:', error);
    return internalError(error);
  }
}

/** Create a user: { username, display_name?, email?, role, password }. */
export async function POST(request: NextRequest) {
  const auth = await requireUserLevel(request, 'admin');
  if (auth instanceof NextResponse) return auth;

  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return fail('Invalid JSON body'); }
  const username = typeof body.username === 'string' ? body.username.trim() : body.username;
  const email = typeof body.email === 'string' ? body.email.trim() : body.email;
  const displayName = typeof body.display_name === 'string' ? body.display_name.trim() : body.display_name;
  const { role, password } = body;

  const invalid = validateUsername(username) || validateRole(role) || validatePassword(password)
    || validateEmail(email) || validateDisplayName(displayName);
  if (invalid) return fail(invalid, 400, 'VALIDATION');

  try {
    const exists = await rqlite.query('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE', [username]);
    if (exists.values?.length) return fail('That username is already taken', 409, 'USERNAME_TAKEN');

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const passwordHash = await hashPassword(password as string);
    await rqlite.execute(
      `INSERT INTO users (id, username, display_name, email, password_hash, role, disabled, password_changed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      [id, username, displayName || null, email || null, passwordHash, role, now, now, now],
    );
    invalidateUserStatus();
    await logAudit({
      userId: auth.userId, action: AuditActions.USER_CREATE, category: 'user', status: 'success',
      details: `Created ${username} (${roleLabel(role)})`, ipAddress: clientIp(request) ?? undefined,
    });
    const r = await rqlite.query(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`, [id]);
    return ok({ user: toUserDto(rowsToObjects(r)[0] || { id, username, role }) }, { status: 201 });
  } catch (error) {
    if (/UNIQUE constraint failed/i.test(String((error as Error)?.message))) {
      return fail('That username is already taken', 409, 'USERNAME_TAKEN');
    }
    console.error('User create error:', error);
    return internalError(error);
  }
}
