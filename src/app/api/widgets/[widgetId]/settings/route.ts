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
    
    // Get or create polling config
    let configRes = await rqlite.query(
      'SELECT * FROM widget_polling_config WHERE widget_type=? AND server_id=?',
      [widget.widget_type, widget.server_id]
    );
    let config = rowsToObjects(configRes)[0];
    
    if (!config) {
      // Create default config
      const configId = generateId();
      await rqlite.execute(
        `INSERT INTO widget_polling_config (id, widget_type, server_id, enabled) VALUES (?, ?, ?, 1)`,
        [configId, widget.widget_type, widget.server_id]
      );
      configRes = await rqlite.query('SELECT * FROM widget_polling_config WHERE id=?', [configId]);
      config = rowsToObjects(configRes)[0];
    }
    
    return NextResponse.json({ data: { widget, config } });
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
    
    const { poll_interval_sec, ttl_sec, storage_mode, enabled } = await request.json();
    const updates: string[] = [];
    const values: any[] = [];
    
    if (poll_interval_sec !== undefined) {
      updates.push('poll_interval_sec=?');
      values.push(poll_interval_sec);
    }
    if (ttl_sec !== undefined) {
      updates.push('ttl_sec=?');
      values.push(ttl_sec);
    }
    if (storage_mode !== undefined) {
      updates.push('storage_mode=?');
      values.push(storage_mode);
    }
    if (enabled !== undefined) {
      updates.push('enabled=?');
      values.push(enabled ? 1 : 0);
    }
    
    if (!updates.length) {
      return NextResponse.json({ error: { message: 'Nothing to update' } }, { status: 400 });
    }
    
    updates.push('updated_at=CURRENT_TIMESTAMP');
    
    // Upsert
    const existingRes = await rqlite.query(
      'SELECT id FROM widget_polling_config WHERE widget_type=? AND server_id=?',
      [widget.widget_type, widget.server_id]
    );
    const existing = rowsToObjects(existingRes)[0];
    
    if (existing) {
      await rqlite.execute(
        `UPDATE widget_polling_config SET ${updates.join(',')} WHERE id=?`,
        [...values, existing.id]
      );
    } else {
      const configId = generateId();
      await rqlite.execute(
        `INSERT INTO widget_polling_config (id, widget_type, server_id, poll_interval_sec, ttl_sec, storage_mode, enabled) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [configId, widget.widget_type, widget.server_id, poll_interval_sec ?? null, ttl_sec ?? null, storage_mode ?? 'latest_ttl', enabled ?? 1]
      );
    }
    
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: { message: String(error) } }, { status: 500 });
  }
}