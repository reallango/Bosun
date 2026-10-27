import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireRole } from '@/lib/auth/middleware';
import { rqlite } from '@/lib/db/rqlite-client';
import { ok, fail, failFrom } from '@/lib/api/response';

/** Update a rule: { enabled?, threshold?, name?, cooldown_sec? }. Admin only. */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ ruleId: string }> }) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const roleError = requireRole(auth, 'admin');
  if (roleError) return roleError;
  const { ruleId } = await params;
  try {
    const b = await request.json();
    const sets: string[] = [];
    const values: unknown[] = [];
    if (b.enabled !== undefined) { sets.push('enabled = ?'); values.push(b.enabled ? 1 : 0); }
    if (b.threshold !== undefined) {
      const t = Number(b.threshold);
      if (!Number.isFinite(t)) return fail('threshold must be a number');
      sets.push('threshold = ?'); values.push(t);
    }
    if (typeof b.name === 'string' && b.name.trim()) { sets.push('name = ?'); values.push(b.name.trim().slice(0, 100)); }
    const cd = b.cooldown_sec ?? b.cooldown_seconds;
    if (cd !== undefined) { sets.push('cooldown_sec = ?'); values.push(Math.max(30, Math.min(7 * 86400, Math.round(Number(cd)) || 300))); }
    if (!sets.length) return fail('Nothing to update');
    sets.push('updated_at = CURRENT_TIMESTAMP');
    const r = await rqlite.execute(`UPDATE alert_rules SET ${sets.join(', ')} WHERE id = ?`, [...values, ruleId]);
    if (!r.rows_affected) return fail('Rule not found', 404);
    return ok({ updated: true });
  } catch (error) {
    return failFrom(error);
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ ruleId: string }> }) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const roleError = requireRole(auth, 'admin');
  if (roleError) return roleError;
  const { ruleId } = await params;
  try {
    await rqlite.execute('DELETE FROM alert_rules WHERE id = ?', [ruleId]);
    return ok({ deleted: true });
  } catch (error) {
    return failFrom(error);
  }
}
