import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireRole } from '@/lib/auth/middleware';
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';

// Simple UUID generator
function generateId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ widgetId: string }> }) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const roleError = requireRole(auth as any, 'viewer');
  if (roleError) return roleError;
  const { widgetId } = await params;
  
  try {
    // Get widget info first
    const widgetRes = await rqlite.query('SELECT * FROM widgets WHERE id=?', [widgetId]);
    const widgets = rowsToObjects(widgetRes);
    if (!widgets.length) {
      return NextResponse.json({ error: { message: 'Widget not found' } }, { status: 404 });
    }
    const widget = widgets[0];
    
    // Get or create polling config using widget_id
    let configRes = await rqlite.query(
      'SELECT * FROM widget_polling_config WHERE widget_id=?',
      [widgetId]
    );
    let config = rowsToObjects(configRes)[0];
    
    if (!config) {
      // Create default config for this widget
      const configId = generateId();
      await rqlite.execute(
        `INSERT INTO widget_polling_config (id, widget_id, widget_type, server_id, enabled) VALUES (?, ?, ?, ?, 1)`,
        [configId, widgetId, widget.widget_type, widget.server_id]
      );
      configRes = await rqlite.query('SELECT * FROM widget_polling_config WHERE id=?', [configId]);
      config = rowsToObjects(configRes)[0];
    }
    
    // Return combined widget + config data with display_name alias for title_override
    return NextResponse.json({ 
      data: { 
        ...widget,
        ...config,
        display_name: widget.title_override 
      } 
    });
  } catch (error) {
    return NextResponse.json({ error: { message: String(error) } }, { status: 500 });
  }
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ widgetId: string }> }) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const roleError = requireRole(auth as any, 'operator');
  if (roleError) return roleError;
  const { widgetId } = await params;
  
  try {
    // Get widget info
    const widgetRes = await rqlite.query('SELECT * FROM widgets WHERE id=?', [widgetId]);
    const widgets = rowsToObjects(widgetRes);
    if (!widgets.length) {
      return NextResponse.json({ error: { message: 'Widget not found' } }, { status: 404 });
    }
    const widget = widgets[0];
    
    const { display_name, title_override, poll_interval_sec, ttl_sec, storage_mode, enabled, grid_w, grid_h } = await request.json();
    
    // Update widget table fields (title_override and grid size)
    const widgetUpdates: string[] = [];
    const widgetValues: any[] = [];
    
    // Handle display_name as alias for title_override
    const nameToSave = title_override ?? display_name;
    if (nameToSave !== undefined) {
      widgetUpdates.push('title_override=?');
      widgetValues.push(nameToSave || null);
    }
    if (grid_w !== undefined) {
      widgetUpdates.push('grid_w=?');
      widgetValues.push(grid_w);
    }
    if (grid_h !== undefined) {
      widgetUpdates.push('grid_h=?');
      widgetValues.push(grid_h);
    }
    
    if (widgetUpdates.length > 0) {
      widgetUpdates.push('updated_at=CURRENT_TIMESTAMP');
      await rqlite.execute(
        `UPDATE widgets SET ${widgetUpdates.join(',')} WHERE id=?`,
        [...widgetValues, widgetId]
      );
    }
    
    // Update polling config (per-widget)
    const configUpdates: string[] = [];
    const configValues: any[] = [];
    
    if (poll_interval_sec !== undefined) {
      configUpdates.push('poll_interval_sec=?');
      configValues.push(poll_interval_sec);
    }
    if (ttl_sec !== undefined) {
      configUpdates.push('ttl_sec=?');
      configValues.push(ttl_sec);
    }
    if (storage_mode !== undefined) {
      configUpdates.push('storage_mode=?');
      configValues.push(storage_mode);
    }
    if (enabled !== undefined) {
      configUpdates.push('enabled=?');
      configValues.push(enabled ? 1 : 0);
    }
    
    // Upsert polling config by widget_id
    const existingRes = await rqlite.query(
      'SELECT id FROM widget_polling_config WHERE widget_id=?',
      [widgetId]
    );
    const existing = rowsToObjects(existingRes)[0];
    
    if (existing) {
      if (configUpdates.length > 0) {
        configUpdates.push('updated_at=CURRENT_TIMESTAMP');
        await rqlite.execute(
          `UPDATE widget_polling_config SET ${configUpdates.join(',')} WHERE id=?`,
          [...configValues, existing.id]
        );
      }
    } else if (configUpdates.length > 0) {
      const configId = generateId();
      await rqlite.execute(
        `INSERT INTO widget_polling_config (id, widget_id, widget_type, server_id, poll_interval_sec, ttl_sec, storage_mode, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [configId, widgetId, widget.widget_type, widget.server_id, poll_interval_sec ?? null, ttl_sec ?? null, storage_mode ?? 'latest_ttl', enabled ?? 1]
      );
    }
    
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: { message: String(error) } }, { status: 500 });
  }
}