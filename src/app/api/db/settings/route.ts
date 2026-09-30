import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireRole } from '@/lib/auth/middleware';
import { getConfig, setConfig } from '@/lib/db/migrations';
import { EDITABLE_SETTINGS, EDITABLE_SETTING_KEYS } from '@/lib/settings-schema';
import { logAudit, AuditActions } from '@/lib/audit/logger';
import { ok, fail } from '@/lib/api/response';

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const roleError = requireRole(auth, 'viewer');
  if (roleError) return roleError;

  try {
    const values: Record<string, string | null> = {};
    for (const def of EDITABLE_SETTINGS) {
      values[def.key] = await getConfig(def.key);
    }
    return ok({ settings: EDITABLE_SETTINGS, values });
  } catch (error) {
    console.error('Settings read error:', error);
    return fail('Internal server error', 500, 'INTERNAL_ERROR');
  }
}

export async function PUT(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const roleError = requireRole(auth, 'admin');
  if (roleError) return roleError;

  try {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return fail('Expected a JSON object of settings', 400, 'INVALID_BODY');
    }

    const updates: { key: string; value: string }[] = [];
    for (const [key, raw] of Object.entries(body as Record<string, unknown>)) {
      if (!EDITABLE_SETTING_KEYS.includes(key)) {
        return fail(`Unknown or non-editable setting: ${key}`, 400, 'INVALID_SETTING');
      }
      if (raw === null || raw === undefined || raw === '') {
        return fail(`Empty value for setting: ${key}`, 400, 'INVALID_VALUE');
      }
      updates.push({ key, value: String(raw) });
    }

    if (updates.length === 0) {
      return fail('No settings provided', 400, 'NO_SETTINGS');
    }

    for (const { key, value } of updates) {
      await setConfig(key, value);
    }

    await logAudit({
      userId: auth.userId,
      action: AuditActions.CONFIG_UPDATE,
      status: 'success',
      details: `Updated ${updates.map(u => u.key).join(', ')}`,
    });

    const values: Record<string, string | null> = {};
    for (const def of EDITABLE_SETTINGS) {
      values[def.key] = await getConfig(def.key);
    }
    return ok({ updated: updates.map(u => u.key), values });
  } catch (error) {
    console.error('Settings update error:', error);
    return fail('Internal server error', 500, 'INTERNAL_ERROR');
  }
}
