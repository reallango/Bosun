import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/middleware';
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';
import { ok } from '@/lib/api/response';
import { withoutSpec } from '@/lib/widgets/custom-widget-input';

/**
 * Database-defined widget types with their raw rows, for Settings → Custom
 * Widgets. `collectorTypes` are the types the code can feed and render, which
 * is what registration is limited to.
 */
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  try {
    const res = await rqlite.query('SELECT * FROM custom_widgets ORDER BY display_name');
    return ok({ widgets: rowsToObjects(res).map(withoutSpec) });
  } catch {
    return ok({ widgets: [] });
  }
}
