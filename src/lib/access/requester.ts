/**
 * Rebuild the principal behind a stored request or schedule, so a background run acts with exactly the rights
 * its creator had: a user (disabled or deleted users stop working) or an API key (revoked, expired, or whose
 * creator is gone stops working). Shared by access requests and the schedule engine.
 */
import type { TokenPayload } from '@/lib/auth/jwt';
import { getUserStatus } from '@/lib/auth/user-status';
import { isRole, minRole, type Role } from '@/lib/auth/levels';
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';

export async function requesterPayload(type: string, id: string): Promise<TokenPayload | null> {
  if (type === 'user') {
    const u = rowsToObjects(await rqlite.query('SELECT id, username, role, disabled FROM users WHERE id = ?', [id]))[0];
    if (!u || Number(u.disabled) === 1 || !isRole(u.role)) return null;
    return { userId: String(u.id), username: String(u.username), role: u.role, authType: 'session' };
  }
  const k = rowsToObjects(await rqlite.query('SELECT id, name, role, revoked_at, expires_at, created_by FROM api_keys WHERE id = ?', [id]))[0];
  if (!k || k.revoked_at || (k.expires_at && Date.parse(String(k.expires_at)) <= Date.now()) || !isRole(k.role)) return null;
  let role: Role = k.role;
  if (k.created_by) {
    const creator = await getUserStatus(String(k.created_by));
    if (!creator || creator.disabled || !isRole(creator.role)) return null;
    role = minRole(role, creator.role);
  }
  return { userId: `apikey:${k.id}`, username: String(k.name), role, authType: 'api_key', apiKeyId: String(k.id) };
}
