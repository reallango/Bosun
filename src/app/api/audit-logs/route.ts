import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/middleware';
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  // Only admins can view full audit log - check via headers/middleware
  const isAdmin = request.headers.get('x-user-role') === 'admin';
  if (!isAdmin) {
    return NextResponse.json({ error: { message: 'Admin only' } }, { status: 403 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const userId = searchParams.get('user_id');
    const action = searchParams.get('action');
    const resourceType = searchParams.get('resource_type');
    const limit = parseInt(searchParams.get('limit') || '100', 10);
    const offset = parseInt(searchParams.get('offset') || '0', 10);
    
    let query = 'SELECT * FROM audit_logs WHERE 1=1';
    const params: unknown[] = [];
    
    if (userId) {
      query += ' AND user_id = ?';
      params.push(userId);
    }
    if (action) {
      query += ' AND action = ?';
      params.push(action);
    }
    if (resourceType) {
      query += ' AND resource_type = ?';
      params.push(resourceType);
    }
    
    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);
    
    const result = await rqlite.query(query, params);
    const logs = rowsToObjects(result).map((l: Record<string, unknown>) => ({
      ...l,
      details: l.details ? JSON.parse(l.details as string) : {}
    }));

    return NextResponse.json({ data: { logs } });
  } catch (error) {
    return NextResponse.json({ error: { message: String(error) } }, { status: 500 });
  }
}