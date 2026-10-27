import { NextRequest, NextResponse } from 'next/server';
import { requireLevel } from '@/lib/auth/middleware';
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';
import { internalError } from '@/lib/api/response';

/**
 * Audit log (Full access only). Filters: user_id, action (substring, e.g.
 * "create" or "docker."), category. Rows carry both the raw columns and the
 * fields the Audit Log page shows (user_email = user or API key name,
 * resource_type = category, resource_id = server).
 */
export async function GET(request: NextRequest) {
  const auth = await requireLevel(request, 'admin');
  if (auth instanceof NextResponse) return auth;

  try {
    const { searchParams } = new URL(request.url);
    const userId = searchParams.get('user_id');
    const action = searchParams.get('action');
    const category = searchParams.get('category') || searchParams.get('resource_type');
    const limit = Math.min(500, Math.max(1, parseInt(searchParams.get('limit') || '100', 10) || 100));
    const offset = Math.max(0, parseInt(searchParams.get('offset') || '0', 10) || 0);

    let query = `SELECT a.*, u.username AS username, k.name AS api_key_name, s.name AS server_name
      FROM audit_log a
      LEFT JOIN users u ON u.id = a.user_id
      LEFT JOIN api_keys k ON a.user_id = 'apikey:' || k.id
      LEFT JOIN servers s ON s.id = a.server_id
      WHERE 1=1`;
    const params: unknown[] = [];
    if (userId) { query += ' AND a.user_id = ?'; params.push(userId); }
    if (action) { query += ' AND a.action LIKE ?'; params.push(`%${action}%`); }
    if (category) { query += ' AND a.category = ?'; params.push(category); }
    query += ' ORDER BY a.created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const result = await rqlite.query(query, params);
    const logs = rowsToObjects(result).map(l => ({
      ...l,
      user_email: l.username ?? (l.api_key_name ? `API key: ${l.api_key_name}` : l.user_id ?? 'system'),
      resource_type: l.category,
      resource_id: l.server_name ?? l.server_id ?? null,
    }));
    return NextResponse.json({ data: { logs } });
  } catch (error) {
    console.error('Audit log error:', error);
    return internalError(error);
  }
}
