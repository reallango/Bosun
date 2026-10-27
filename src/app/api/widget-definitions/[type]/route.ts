import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireRole } from '@/lib/auth/middleware';
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';
import { ok, fail, failFrom } from '@/lib/api/response';
import { sanitizeCustomWidget } from '@/lib/widgets/custom-widget-input';

/**
 * Admin management of one database-defined widget type: rename, resize
 * defaults, restrict platforms, edit config fields, enable/disable. Compiled
 * built-ins are read-only.
 */

export async function GET(request: NextRequest, { params }: { params: Promise<{ type: string }> }) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const { type } = await params;
  try {
    const res = await rqlite.query('SELECT * FROM custom_widgets WHERE type = ?', [type]);
    const rows = rowsToObjects(res);
    return rows.length ? ok({ widget: rows[0] }) : fail('Custom widget not found', 404);
  } catch (error) {
    return failFrom(error);
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ type: string }> }) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const roleError = requireRole(auth, 'admin');
  if (roleError) return roleError;
  const { type } = await params;
  try {
    const existing = await rqlite.query('SELECT supports_linux, supports_windows FROM custom_widgets WHERE type = ?', [type]);
    if (!existing.values?.length) return fail('Custom widget not found (built-in types are read-only)', 404);
    const body = await request.json();
    const v = sanitizeCustomWidget(body, false);
    if ('error' in v) return fail(v.error);
    const linux = v.values.supports_linux ?? Number(existing.values[0][0]);
    const windows = v.values.supports_windows ?? Number(existing.values[0][1]);
    if (!linux && !windows) return fail('A widget must support at least one platform');
    const cols = Object.keys(v.values) as (keyof typeof v.values)[];
    if (!cols.length) return fail('No updatable fields provided');
    await rqlite.execute(
      `UPDATE custom_widgets SET ${cols.map(c => `${c} = ?`).join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE type = ?`,
      [...cols.map(c => v.values[c]), type]);
    const updated = await rqlite.query('SELECT * FROM custom_widgets WHERE type = ?', [type]);
    return ok({ widget: rowsToObjects(updated)[0] });
  } catch (error) {
    return failFrom(error);
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ type: string }> }) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const roleError = requireRole(auth, 'admin');
  if (roleError) return roleError;
  const { type } = await params;
  try {
    // Widgets of a deleted type would render as "unknown" with no way back.
    const inUse = await rqlite.query('SELECT COUNT(*) FROM widgets WHERE widget_type = ?', [type]);
    const count = Number(inUse.values?.[0]?.[0] || 0);
    if (count > 0) return fail(`Cannot delete: ${count} widget instance(s) still use this type`, 409);
    const r = await rqlite.execute('DELETE FROM custom_widgets WHERE type = ? AND builtin = 0', [type]);
    if (!r.rows_affected) return fail('Custom widget not found, or built-in (disable it instead)', 404);
    return ok({ deleted: true });
  } catch (error) {
    return failFrom(error);
  }
}
