import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/middleware';
import { requirePermission } from '@/lib/permissions/authorize';
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';
import { resolveWidgetDefinition } from '@/components/widgets/registry-loader';
import { COMMAND_CHANGE_FORBIDDEN, changesCommand, mayChangeCommand } from '@/lib/auth/widget-policy';

/**
 * Widget settings. Polling is per server (one batched collection per host),
 * so `poll_interval_sec` / `enabled` here read and write the widget's server.
 * `ttl_sec` / `storage_mode` are accepted for compatibility and ignored:
 * history retention is global (Database settings).
 */

export async function GET(request: NextRequest, { params }: { params: Promise<{ widgetId: string }> }) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const { widgetId } = await params;
  try {
    const r = await rqlite.query(
      'SELECT w.*, s.poll_interval_sec, s.poll_enabled, s.name AS server_name FROM widgets w LEFT JOIN servers s ON s.id = w.server_id WHERE w.id = ?',
      [widgetId]);
    const widget = rowsToObjects(r)[0];
    if (!widget) return NextResponse.json({ error: { message: 'Widget not found' } }, { status: 404 });
    const def = await resolveWidgetDefinition(String(widget.widget_type));
    let config: unknown = {};
    try { config = typeof widget.config === 'string' ? JSON.parse(widget.config || '{}') : widget.config || {}; } catch { config = {}; }
    return NextResponse.json({
      data: {
        ...widget,
        enabled: widget.poll_enabled,
        config,
        // Fields the settings dialog renders into widgets.config.
        config_schema: def?.configSchema || [],
        storage_mode: 'server',
        ttl_sec: null,
        display_name: widget.title_override,
      },
    });
  } catch (error) {
    return NextResponse.json({ error: { message: String(error) } }, { status: 500 });
  }
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ widgetId: string }> }) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const roleError = await requirePermission(auth, 'dashboards.edit');
  if (roleError) return roleError;
  const { widgetId } = await params;

  try {
    const r = await rqlite.query('SELECT id, server_id, widget_type, config FROM widgets WHERE id = ?', [widgetId]);
    const widget = rowsToObjects(r)[0];
    if (!widget) return NextResponse.json({ error: { message: 'Widget not found' } }, { status: 404 });

    const body = await request.json();
    const { display_name, title_override, poll_interval_sec, enabled, grid_w, grid_h, config } = body;
    const stmts: { sql: string; params: unknown[] }[] = [];

    const sets: string[] = [];
    const values: unknown[] = [];
    const name = title_override ?? display_name;
    if (name !== undefined) { sets.push('title_override = ?'); values.push(name ? String(name).slice(0, 100) : null); }
    if (grid_w !== undefined) { sets.push('grid_w = ?'); values.push(Math.max(1, Math.min(48, Number(grid_w) || 4))); }
    if (grid_h !== undefined) { sets.push('grid_h = ?'); values.push(Math.max(1, Math.min(48, Number(grid_h) || 3))); }
    if (config !== undefined && typeof config === 'object' && config !== null && !Array.isArray(config)) {
      // Merge so the dialog (schema fields) and widgets that keep their own
      // state in config (e.g. Metrics History) do not overwrite each other.
      let existing: Record<string, unknown> = {};
      try { existing = JSON.parse(String(widget.config || '{}')) || {}; } catch { existing = {}; }
      // Unset fields count as their default (the dialog sends defaults back).
      const defaults = Object.fromEntries(((await resolveWidgetDefinition(String(widget.widget_type)))?.configSchema || [])
        .filter(f => f.default !== undefined).map(f => [f.key, f.default]));
      if (changesCommand({ ...defaults, ...existing }, config) && !mayChangeCommand(auth.role)) {
        return NextResponse.json({ error: { message: COMMAND_CHANGE_FORBIDDEN, code: 'FORBIDDEN' } }, { status: 403 });
      }
      const merged = { ...existing, ...config };
      if (JSON.stringify(merged).length > 16 * 1024) return NextResponse.json({ error: { message: 'Widget config too large' } }, { status: 400 });
      sets.push('config = ?');
      values.push(JSON.stringify(merged));
    }
    if (sets.length) {
      sets.push('updated_at = CURRENT_TIMESTAMP');
      stmts.push({ sql: `UPDATE widgets SET ${sets.join(', ')} WHERE id = ?`, params: [...values, widgetId] });
    }

    // Server polling settings from a widget dialog: applied for admins only,
    // ignored for other roles so they can still rename/resize widgets.
    if ((poll_interval_sec !== undefined || enabled !== undefined) && auth.role === 'admin') {
      if (poll_interval_sec !== undefined && poll_interval_sec !== null) {
        stmts.push({ sql: 'UPDATE servers SET poll_interval_sec = ? WHERE id = ?',
          params: [Math.min(3600, Math.max(5, Math.round(Number(poll_interval_sec) || 15))), widget.server_id] });
      }
      if (enabled !== undefined) {
        stmts.push({ sql: 'UPDATE servers SET poll_enabled = ? WHERE id = ?', params: [enabled ? 1 : 0, widget.server_id] });
      }
    }

    if (stmts.length) await rqlite.executeBatch(stmts, { transaction: true });
    return NextResponse.json({ success: true, data: { success: true } });
  } catch (error) {
    return NextResponse.json({ error: { message: String(error) } }, { status: 500 });
  }
}
