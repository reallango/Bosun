import { NextRequest, NextResponse } from 'next/server';
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';
import { requireAuth } from '@/lib/auth/middleware';
import { hasPermission, requirePermission } from '@/lib/permissions/authorize';
import { loadWidgetSpec, loadRuntimeData, RuntimeError } from '@/lib/widgets/runtime/execute';
import { serverVisible } from '@/lib/permissions/effective';

/* eslint-disable @typescript-eslint/no-explicit-any */

function parseJson(v: unknown, fallback: any = {}) {
  if (typeof v !== 'string') return v ?? fallback;
  try { return JSON.parse(v); } catch { return fallback; }
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ widgetId: string }> }) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const { widgetId } = await params;
  // Forcing a poll (or an update check, or re-running a custom command) is an action. Callers
  // without the permission for this server silently get the regular (cached) data instead.
  const requested = new URL(request.url).searchParams.get('force');
  let forceParam: string | null = null;
  let force = false;

  try {
    const widgetRes = await rqlite.query('SELECT * FROM widgets WHERE id = ?', [widgetId]);
    if (!widgetRes.values?.length) return NextResponse.json({ error: { message: 'Widget not found' } }, { status: 404 });
    const widget = rowsToObjects(widgetRes)[0] as any;
    if (requested === 'true' && await hasPermission(auth, 'servers.refresh', widget.server_id)) forceParam = 'true';
    force = forceParam !== null;
    if (!(await serverVisible(auth, widget.server_id))) return NextResponse.json({ error: { message: 'Widget not found' } }, { status: 404 });
    const cfg = parseJson(widget.config);
    const srvRes = await rqlite.query(
      'SELECT id, name, hostname, platform, os_type, os_version, is_online, last_seen, last_error, poll_interval_sec FROM servers WHERE id = ?',
      [widget.server_id]);
    if (!srvRes.values?.length) return NextResponse.json({ error: { message: 'Server not found' } }, { status: 404 });
    const server = rowsToObjects(srvRes)[0] as Record<string, any>;

    // Package widgets: data comes from the spec's snapshot section or from its command or script.
    // The data permission of a package widget is checked here, before its data is served.
    const loaded = await loadWidgetSpec(widget.widget_type);
    if (loaded) {
      if (loaded.spec.data.permission) {
        const denied = await requirePermission(auth, loaded.spec.data.permission, server.id);
        if (denied) return denied;
      }
    }
    if (loaded) {
      try {
        const rt = await loadRuntimeData(server.id, loaded, force, cfg, widgetId);
        return NextResponse.json({ ...rt, stale: false, ...(loaded.spec.version >= 2 ? { config: cfg } : {}), server: { is_online: !!server.is_online, last_error: server.last_error ?? null, name: server.name, hostname: server.hostname, platform: server.platform || 'linux' } },
          { headers: { 'Cache-Control': 'no-store' } });
      } catch (err) {
        if (err instanceof RuntimeError) return NextResponse.json({ error: { message: err.message, code: err.code } }, { status: err.status });
        throw err;
      }
    }

    return NextResponse.json({ error: { message: `Unknown widget type: ${widget.widget_type}` } }, { status: 400 });
  } catch (error) {
    console.error('Widget data error:', error);
    const status = (error as any)?.status;
    return NextResponse.json(
      { error: { message: error instanceof Error ? error.message : String(error) } },
      { status: typeof status === 'number' ? status : 500 });
  }
}
