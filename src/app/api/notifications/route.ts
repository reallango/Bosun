import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/middleware';
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';
import { randomUUID } from 'crypto';

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const user = auth as any;

  try {
    const { searchParams } = new URL(request.url);
    const unreadOnly = searchParams.get('unread') === 'true';
    
    let query = 'SELECT * FROM notifications WHERE 1=1';
    const params: any[] = [];
    
    // Filter by user if not admin
    if (user.role !== 'admin') {
      query += ' AND (user_id = ? OR user_id IS NULL)';
      params.push(user.id);
    }
    
    if (unreadOnly) {
      query += ' AND is_read = 0';
    }
    
    query += ' ORDER BY created_at DESC LIMIT 50';
    
    const result = await rqlite.query(query, params);
    const notifications = rowsToObjects(result).map((n: any) => ({
      ...n,
      config: n.config ? JSON.parse(n.config) : {}
    }));

    return NextResponse.json({ data: { notifications } });
  } catch (error) {
    return NextResponse.json({ error: { message: String(error) } }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const user = auth as any;
  
  // Only admins can create notifications
  if (user.role !== 'admin') {
    return NextResponse.json({ error: { message: 'Admin only' } }, { status: 403 });
  }

  try {
    const body = await request.json();
    const { server_id, severity, title, message } = body;
    
    const id = randomUUID();
    const now = new Date().toISOString();
    
    await rqlite.execute(
      `INSERT INTO notifications (id, server_id, severity, title, message, is_read, is_dismissed, delivered_via, created_at) 
       VALUES (?, ?, ?, ?, ?, 0, 0, 'in_app', ?)`,
      [id, server_id || null, severity || 'info', title, message, now]
    );

    return NextResponse.json({ data: { id, message: 'Notification created' } }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: { message: String(error) } }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  try {
    const body = await request.json();
    const { id, is_read, is_dismissed } = body;
    
    if (!id) {
      return NextResponse.json({ error: { message: 'ID required' } }, { status: 400 });
    }

    const updates: string[] = [];
    const params: any[] = [];
    
    if (is_read !== undefined) {
      updates.push('is_read = ?');
      params.push(is_read ? 1 : 0);
    }
    if (is_dismissed !== undefined) {
      updates.push('is_dismissed = ?');
      params.push(is_dismissed ? 1 : 0);
    }
    
    if (updates.length === 0) {
      return NextResponse.json({ error: { message: 'No fields to update' } }, { status: 400 });
    }
    
    params.push(id);
    
    await rqlite.execute(
      `UPDATE notifications SET ${updates.join(', ')} WHERE id = ?`,
      params
    );

    return NextResponse.json({ data: { message: 'Updated' } });
  } catch (error) {
    return NextResponse.json({ error: { message: String(error) } }, { status: 500 });
  }
}