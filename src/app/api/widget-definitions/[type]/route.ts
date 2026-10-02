import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireRole } from '@/lib/auth/middleware';
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';

/**
 * Admin management of a single custom widget *type*.
 *
 * PATCH lets an operator retune a database-defined widget without editing SQL:
 * enable/disable it, switch database caching on/off, and choose which platforms
 * it supports (linux, windows, or both). Only rows in `custom_widgets` are
 * mutable; compiled built-ins are read-only.
 */

const COLUMNS: Record<string, string> = {
  display_name: 'display_name',
  description: 'description',
  icon: 'icon',
  category: 'category',
  default_size: 'default_size',
  min_size: 'min_size',
  refresh_interval: 'refresh_interval',
  use_database: 'use_database',
  supports_linux: 'supports_linux',
  supports_windows: 'supports_windows',
  default_poll_interval: 'default_poll_interval',
  default_ttl: 'default_ttl',
  storage_mode: 'storage_mode',
  config_schema: 'config_schema',
  enabled: 'enabled',
};

const JSON_COLUMNS = new Set(['default_size', 'min_size', 'config_schema']);
const BOOL_COLUMNS = new Set(['use_database', 'supports_linux', 'supports_windows', 'enabled']);

export async function GET(request: NextRequest, { params }: { params: Promise<{ type: string }> }) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const { type } = await params;

  const res = await rqlite.query('SELECT * FROM custom_widgets WHERE type = ?', [type]);
  const rows = rowsToObjects(res);
  if (!rows.length) return NextResponse.json({ error: { message: 'Custom widget not found' } }, { status: 404 });
  return NextResponse.json({ data: { widget: rows[0] } });
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ type: string }> }) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const roleError = requireRole(auth as any, 'admin');
  if (roleError) return roleError;
  const { type } = await params;

  try {
    const existing = await rqlite.query('SELECT id FROM custom_widgets WHERE type = ?', [type]);
    if (!existing.values?.length) {
      return NextResponse.json({ error: { message: 'Custom widget not found (built-in types are read-only)' } }, { status: 404 });
    }

    const body = await request.json();
    const updates: string[] = [];
    const values: any[] = [];
    for (const [key, value] of Object.entries(body)) {
      const column = COLUMNS[key];
      if (!column) continue;
      updates.push(`${column}=?`);
      if (JSON_COLUMNS.has(key)) values.push(JSON.stringify(value));
      else if (BOOL_COLUMNS.has(key)) values.push(value ? 1 : 0);
      else values.push(value as any);
    }
    if (!updates.length) {
      return NextResponse.json({ error: { message: 'No updatable fields provided' } }, { status: 400 });
    }

    updates.push('updated_at=CURRENT_TIMESTAMP');
    await rqlite.execute(`UPDATE custom_widgets SET ${updates.join(',')} WHERE type=?`, [...values, type]);

    const updated = await rqlite.query('SELECT * FROM custom_widgets WHERE type = ?', [type]);
    return NextResponse.json({ data: { widget: rowsToObjects(updated)[0] } });
  } catch (error) {
    return NextResponse.json({ error: { message: String(error) } }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ type: string }> }) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const roleError = requireRole(auth as any, 'admin');
  if (roleError) return roleError;
  const { type } = await params;

  // Refuse to delete a type that still has widget instances; otherwise those
  // widgets would render as "unknown type" with no way to recover.
  const inUse = await rqlite.query('SELECT COUNT(*) FROM widgets WHERE widget_type = ?', [type]);
  const count = Number(inUse.values?.[0]?.[0] || 0);
  if (count > 0) {
    return NextResponse.json({ error: { message: `Cannot delete: ${count} widget instance(s) still use this type` } }, { status: 409 });
  }

  const existing = await rqlite.query('SELECT id FROM custom_widgets WHERE type = ?', [type]);
  if (!existing.values?.length) return NextResponse.json({ error: { message: 'Custom widget not found' } }, { status: 404 });

  await rqlite.execute('DELETE FROM custom_widgets WHERE type = ?', [type]);
  return NextResponse.json({ success: true });
}
