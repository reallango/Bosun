import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/middleware';
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';

/**
 * List database-defined widget types with their raw configuration, for the
 * Custom Widgets settings page. Individual types are managed via
 * /api/widget-definitions/[type].
 */
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  try {
    const res = await rqlite.query('SELECT * FROM custom_widgets ORDER BY display_name');
    return NextResponse.json({ data: { widgets: rowsToObjects(res) } });
  } catch {
    // Before migration 008 the table does not exist; treat that as "none".
    return NextResponse.json({ data: { widgets: [] } });
  }
}
