import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { requireAuth, requireRole } from '@/lib/auth/middleware';
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';
import { getWidgetDefinitions, resolveWidgetDefinition, CUSTOM_WIDGET_DATA_TYPES } from '@/components/widgets/registry-loader';
import { ok, fail, failFrom } from '@/lib/api/response';
import { sanitizeCustomWidget, withoutSpec } from '@/lib/widgets/custom-widget-input';
import { hasPermission } from '@/lib/permissions/authorize';
import { loadWidgetSpec } from '@/lib/widgets/runtime/execute';

/**
 * GET /api/widget-definitions?serverId=<id>
 *   Built-in + enabled custom definitions supported by that server's platform
 *   (everything without serverId). Cached briefly: definitions only change
 *   when an admin edits a custom widget, and the Add Widget picker reopens often.
 */
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  try {
    const serverId = new URL(request.url).searchParams.get('serverId');
    let platform: string | undefined;
    if (serverId) {
      const srv = await rqlite.query('SELECT platform FROM servers WHERE id = ?', [serverId]);
      if (!srv.values?.length) return fail('Server not found', 404);
      platform = (srv.values[0][0] as string) || 'linux';
    }
    let definitions = await getWidgetDefinitions(platform);
    // Package widgets are offered only to those who hold their data permission (for that server, when one is given).
    if (auth.role !== 'admin') {
      const keep: typeof definitions = [];
      for (const d of definitions) {
        const perm = d.packageId ? (await loadWidgetSpec(d.type))?.spec.data.permission : null;
        if (!perm || await hasPermission(auth, perm, serverId)) keep.push(d);
      }
      definitions = keep;
    }
    return NextResponse.json(
      { data: { definitions, platform: platform ?? null } },
      { headers: { 'Cache-Control': 'private, max-age=60' } });
  } catch (error) {
    return failFrom(error);
  }
}

/**
 * Register a custom widget type (admin). Only types the code can render and
 * feed (CUSTOM_WIDGET_DATA_TYPES) are accepted, so an admin cannot create a
 * widget that has no data source.
 */
export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const roleError = requireRole(auth, 'admin');
  if (roleError) return roleError;
  try {
    const body = await request.json();
    const type = String(body?.type || '');
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(type)) return fail('type must be a lowercase identifier');
    if (!CUSTOM_WIDGET_DATA_TYPES.includes(type)) return fail(`No data source implemented for type "${type}"`);
    if (await resolveWidgetDefinition(type)) return fail(`Widget type "${type}" already exists`, 409);
    const v = sanitizeCustomWidget(body, true);
    if ('error' in v) return fail(v.error);

    const id = crypto.randomUUID();
    await rqlite.execute(
      `INSERT INTO custom_widgets (id, type, display_name, description, icon, category, default_size, min_size, refresh_interval,
         supports_linux, supports_windows, config_schema, enabled, builtin)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [id, type, v.values.display_name, v.values.description ?? '', v.values.icon ?? 'puzzle', v.values.category ?? 'custom',
        v.values.default_size ?? '{"w":8,"h":6}', v.values.min_size ?? '{"w":4,"h":4}', v.values.refresh_interval ?? 30,
        v.values.supports_linux ?? 1, v.values.supports_windows ?? 1, v.values.config_schema ?? '[]', v.values.enabled ?? 1]);
    const created = await rqlite.query('SELECT * FROM custom_widgets WHERE id = ?', [id]);
    return ok({ widget: withoutSpec(rowsToObjects(created)[0]) }, { status: 201 });
  } catch (error) {
    return failFrom(error);
  }
}
