import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { clientIp, requireUserLevel } from '@/lib/auth/middleware';
import { expiryFromDays, generateApiKey } from '@/lib/auth/api-keys';
import { API_KEY_COLUMNS, toApiKeyDto } from '@/lib/auth/api-key-dto';
import { roleLabel, isRole } from '@/lib/auth/levels';
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';
import { groupIdsByPrincipal } from '@/lib/permissions/groups';
import { logAudit, AuditActions } from '@/lib/audit/logger';
import { fail, internalError, ok } from '@/lib/api/response';

/** List API keys (never the key or its hash). Full access, signed-in users only. */
export async function GET(request: NextRequest) {
  const auth = await requireUserLevel(request, 'admin');
  if (auth instanceof NextResponse) return auth;
  try {
    const r = await rqlite.query(
      `SELECT ${API_KEY_COLUMNS}, u.username AS created_by_username
       FROM api_keys k LEFT JOIN users u ON u.id = k.created_by ORDER BY k.created_at DESC`);
    const groups = await groupIdsByPrincipal('api_key');
    return ok({ keys: rowsToObjects(r).map(row => ({ ...toApiKeyDto(row), group_ids: groups.get(String(row.id)) || [] })) });
  } catch (error) {
    console.error('API key list error:', error);
    return internalError(error);
  }
}

/**
 * Create an API key: { name, role, expires_in_days?: 30 | 90 | 365 | null }.
 * The response carries the full key once; only its hash is stored.
 */
export async function POST(request: NextRequest) {
  const auth = await requireUserLevel(request, 'admin');
  if (auth instanceof NextResponse) return auth;

  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return fail('Invalid JSON body'); }
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > 100) return fail('Name is required (at most 100 characters)', 400, 'VALIDATION');
  if (!isRole(body.role)) return fail('Role must be viewer, operator or admin', 400, 'VALIDATION');
  const role = body.role;
  const expiresAt = expiryFromDays(body.expires_in_days);
  if (expiresAt === undefined) return fail('expires_in_days must be a whole number of days (1-3650) or null', 400, 'VALIDATION');

  try {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    let generated = generateApiKey();
    for (let attempt = 0; ; attempt++) {
      try {
        await rqlite.execute(
          `INSERT INTO api_keys (id, name, key_prefix, key_hash, role, created_by, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, name, generated.prefix, generated.hash, role, auth.userId, now, expiresAt],
        );
        break;
      } catch (err) {
        // Prefix collision (UNIQUE key_prefix): extremely unlikely; try a new key.
        if (attempt < 3 && /UNIQUE constraint failed/i.test(String((err as Error)?.message))) {
          generated = generateApiKey();
          continue;
        }
        throw err;
      }
    }
    await logAudit({
      userId: auth.userId, action: AuditActions.API_KEY_CREATE, category: 'api_key', status: 'success',
      details: `${name} (${roleLabel(role)}, prefix ${generated.prefix}${expiresAt ? `, expires ${expiresAt.slice(0, 10)}` : ''})`,
      ipAddress: clientIp(request) ?? undefined,
    });
    const r = await rqlite.query(
      `SELECT ${API_KEY_COLUMNS}, NULL AS created_by_username FROM api_keys k WHERE k.id = ?`, [id]);
    return ok({ key: generated.key, apiKey: toApiKeyDto(rowsToObjects(r)[0]) }, { status: 201 });
  } catch (error) {
    console.error('API key create error:', error);
    return internalError(error);
  }
}
