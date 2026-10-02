import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireRole } from '@/lib/auth/middleware';
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';
import { getWidgetDefinitions, resolveWidgetDefinition } from '@/components/widgets/registry-loader';
import { CUSTOM_WIDGET_DATA_TYPES } from '@/lib/custom-widgets/collectors';
import crypto from 'crypto';

/**
 * Widget definitions for the Add Widget picker.
 *
 * GET /api/widget-definitions?serverId=<id>
 *   Returns the built-in + custom definitions supported by that server's
 *   platform. Without `serverId` it returns everything.
 */
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  try {
    const serverId = new URL(request.url).searchParams.get('serverId');
    let platform: string | null | undefined;
    if (serverId) {
      const srv = await rqlite.query('SELECT platform FROM servers WHERE id = ?', [serverId]);
      if (!srv.values?.length) {
        return NextResponse.json({ error: { message: 'Server not found' } }, { status: 404 });
      }
      platform = (srv.values[0][0] as string) || 'linux';
    }
    const definitions = await getWidgetDefinitions(platform);
    return NextResponse.json({ data: { definitions, platform: platform ?? null } });
  } catch (error) {
    return NextResponse.json({ error: { message: String(error) } }, { status: 500 });
  }
}

/**
 * Register a custom widget type.
 *
 * A custom widget must be backed by a collector implementation, so this only
 * accepts types whose collector exists in the shared custom-widgets module
 * (currently `ollama_status`). It exists so operators can add further instances
 * of a custom type and tune its storage/platform/caching behaviour.
 */
export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const roleError = requireRole(auth as any, 'admin');
  if (roleError) return roleError;

  try {
    const body = await request.json();
    const {
      type, display_name, description, icon, category,
      default_size, min_size, refresh_interval,
      use_database, supports_linux, supports_windows,
      default_poll_interval, default_ttl, storage_mode,
      config_schema, enabled,
    } = body;

    if (!type || !display_name) {
      return NextResponse.json({ error: { message: 'type and display_name required' } }, { status: 400 });
    }
    if (!/^[a-z][a-z0-9_]*$/.test(type)) {
      return NextResponse.json({ error: { message: 'type must be a lowercase identifier' } }, { status: 400 });
    }
    if (!CUSTOM_WIDGET_DATA_TYPES.includes(type)) {
      return NextResponse.json({ error: { message: `No collector implemented for type "${type}"` } }, { status: 400 });
    }
    if (await resolveWidgetDefinition(type)) {
      return NextResponse.json({ error: { message: `Widget type "${type}" already exists` } }, { status: 409 });
    }

    const id = crypto.randomUUID();
    await rqlite.execute(
      `INSERT INTO custom_widgets
        (id, type, display_name, description, icon, category, default_size, min_size, refresh_interval,
         use_database, supports_linux, supports_windows, default_poll_interval, default_ttl, storage_mode, config_schema, enabled, builtin)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`,
      [
        id, type, display_name, description || '', icon || 'puzzle', category || 'custom',
        JSON.stringify(default_size || { w: 8, h: 6 }),
        JSON.stringify(min_size || { w: 4, h: 4 }),
        refresh_interval ?? 30,
        use_database === false ? 0 : 1,
        supports_linux === false ? 0 : 1,
        supports_windows === false ? 0 : 1,
        default_poll_interval ?? 30,
        default_ttl ?? 1800,
        storage_mode || 'latest_ttl',
        JSON.stringify(config_schema || []),
        enabled === false ? 0 : 1,
      ]
    );
    const created = await rqlite.query('SELECT * FROM custom_widgets WHERE id = ?', [id]);
    return NextResponse.json({ data: { widget: rowsToObjects(created)[0] } }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: { message: String(error) } }, { status: 500 });
  }
}
