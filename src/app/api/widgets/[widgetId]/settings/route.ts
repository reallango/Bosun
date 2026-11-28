import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/middleware';
import { requirePermission } from '@/lib/permissions/authorize';
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';
import { widgetVisible } from '@/lib/widgets/visibility';
import { resolveWidgetDefinition } from '@/components/widgets/registry-loader';
import { loadWidgetSpec } from '@/lib/widgets/runtime/execute';
import { lookConfigField, lookMinSize, withLookDefault } from '@/lib/widgets/runtime/looks';
import { applyLookMinSize, parseMinSize } from '@/lib/widgets/instance-min-size';
import { denyGuardedConfigChange } from '@/lib/widgets/config-guard-http';

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
  // A widget of a server this caller may not see does not exist for them.
  if (!(await widgetVisible(auth, widgetId))) return NextResponse.json({ error: { message: 'Widget not found' } }, { status: 404 });
  try {
    const r = await rqlite.query(
      'SELECT w.*, s.poll_interval_sec, s.poll_enabled, s.name AS server_name FROM widgets w LEFT JOIN servers s ON s.id = w.server_id WHERE w.id = ?',
      [widgetId]);
    const widget = rowsToObjects(r)[0];
    if (!widget) return NextResponse.json({ error: { message: 'Widget not found' } }, { status: 404 });
    const def = await resolveWidgetDefinition(String(widget.widget_type));
    const loaded = await loadWidgetSpec(String(widget.widget_type));
    let config: Record<string, unknown> = {};
    try {
      const parsed = typeof widget.config === 'string' ? JSON.parse(widget.config || '{}') : widget.config;
      config = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch { config = {}; }
    // A widget that declares looks gets its "Look" choice without listing it in the manifest's config_schema.
    const schema = [...(def?.configSchema || [])];
    if (loaded?.spec.looks) {
      const look = lookConfigField(loaded.spec.looks);
      if (!schema.some(f => f.key === look.key)) schema.push(look);
    }
    return NextResponse.json({
      data: {
        ...widget,
        enabled: widget.poll_enabled,
        config: withLookDefault(loaded?.spec.looks, config),
        // Fields the settings dialog renders into widgets.config.
        config_schema: schema,
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
  // A widget of a server this caller may not see does not exist for them.
  if (!(await widgetVisible(auth, widgetId))) return NextResponse.json({ error: { message: 'Widget not found' } }, { status: 404 });

  try {
    const r = await rqlite.query('SELECT id, server_id, widget_type, config, grid_w, grid_h, grid_min_w, grid_min_h FROM widgets WHERE id = ?', [widgetId]);
    const widget = rowsToObjects(r)[0];
    if (!widget) return NextResponse.json({ error: { message: 'Widget not found' } }, { status: 404 });

    const body = await request.json();
    const { display_name, title_override, poll_interval_sec, enabled, grid_w, grid_h, config } = body;
    const stmts: { sql: string; params: unknown[] }[] = [];

    const sets: string[] = [];
    const values: unknown[] = [];
    const name = title_override ?? display_name;
    if (name !== undefined) { sets.push('title_override = ?'); values.push(name ? String(name).slice(0, 100) : null); }
    const nextGridW = grid_w !== undefined ? Math.max(1, Math.min(48, Number(grid_w) || 4)) : Number(widget.grid_w) || 4;
    const nextGridH = grid_h !== undefined ? Math.max(1, Math.min(48, Number(grid_h) || 3)) : Number(widget.grid_h) || 3;
    if (grid_w !== undefined) { sets.push('grid_w = ?'); values.push(nextGridW); }
    if (grid_h !== undefined) { sets.push('grid_h = ?'); values.push(nextGridH); }

    let existing: Record<string, unknown> = {};
    try { existing = JSON.parse(String(widget.config || '{}')) || {}; } catch { existing = {}; }
    let nextConfig: Record<string, unknown> = existing;
    if (config !== undefined && typeof config === 'object' && config !== null && !Array.isArray(config)) {
      // Merge so the dialog (schema fields) and widgets that keep their own
      // state in config (e.g. Metrics History) do not overwrite each other.
      // Unset fields count as their default (the dialog sends defaults back).
      const schema = (await resolveWidgetDefinition(String(widget.widget_type)))?.configSchema || [];
      const defaults = Object.fromEntries(schema.filter(f => f.default !== undefined).map(f => [f.key, f.default]));
      const guardDenied = await denyGuardedConfigChange(auth, String(widget.server_id), schema, { ...defaults, ...existing }, config);
      if (guardDenied) return guardDenied;
      const merged = { ...existing, ...config };
      if (JSON.stringify(merged).length > 16 * 1024) return NextResponse.json({ error: { message: 'Widget config too large' } }, { status: 400 });
      nextConfig = merged;
      sets.push('config = ?');
      values.push(JSON.stringify(merged));
    }

    // A look may set its own floor (bars need less room than tiles). The instance's minimum follows the selected
    // look; when the floor rises above the current size, the instance grows to fit it.
    const loaded = await loadWidgetSpec(String(widget.widget_type));
    if (loaded?.spec.looks) {
      const baseRows = rowsToObjects(await rqlite.query('SELECT min_size FROM custom_widgets WHERE type = ?', [String(widget.widget_type)]));
      const baseMin = baseRows[0] ? parseMinSize(baseRows[0].min_size) : { w: Number(widget.grid_min_w) || 4, h: Number(widget.grid_min_h) || 4 };
      const applied = applyLookMinSize(
        { grid_min_w: Number(widget.grid_min_w) || 4, grid_min_h: Number(widget.grid_min_h) || 4, grid_w: nextGridW, grid_h: nextGridH },
        lookMinSize(loaded.spec.looks, nextConfig.look) ?? baseMin,
      );
      if (applied) {
        sets.push('grid_min_w = ?', 'grid_min_h = ?', 'grid_w = ?', 'grid_h = ?');
        values.push(applied.grid_min_w, applied.grid_min_h, applied.grid_w, applied.grid_h);
      }
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
