import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/middleware';
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';
import { CUSTOM_WIDGET_DATA_TYPES } from '@/lib/custom-widgets/collectors';

/**
 * List database-defined widget types with their raw configuration, for the
 * Custom Widgets settings page. Individual types are managed via
 * /api/widget-definitions/[type].
 *
 * `collectorTypes` are the custom-widget types that actually have a collector
 * implementation; registration is limited to these, so the page can explain
 * which types are available instead of letting an operator create an
 * uncollectable widget.
 */
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  try {
    const res = await rqlite.query('SELECT * FROM custom_widgets ORDER BY display_name');
    return NextResponse.json({ data: { widgets: rowsToObjects(res), collectorTypes: CUSTOM_WIDGET_DATA_TYPES } });
  } catch {
    // Before migration 008 the table does not exist; treat that as "none".
    return NextResponse.json({ data: { widgets: [], collectorTypes: CUSTOM_WIDGET_DATA_TYPES } });
  }
}
