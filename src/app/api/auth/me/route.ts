import { internalError } from '@/lib/api/response';
import { NextRequest, NextResponse } from 'next/server';
import { verifyAccessToken } from '@/lib/auth/jwt';
import { rqlite } from '@/lib/db/rqlite-client';
import { permissionMap } from '@/lib/permissions/authorize';

export async function GET(request: NextRequest) {
  try {
    const accessToken = request.cookies.get('access_token')?.value;
    if (!accessToken) return NextResponse.json({ error: { message: 'Not authenticated', code: 'NOT_AUTHENTICATED' } }, { status: 401 });
    const payload = await verifyAccessToken(accessToken);
    if (!payload) return NextResponse.json({ error: { message: 'Invalid token', code: 'TOKEN_EXPIRED' } }, { status: 401 });
    const r = await rqlite.query("SELECT id, username, role, display_name, email, preferences, disabled, mfa_method FROM users WHERE id = ?", [payload.userId]);
    if (!r.values || r.values.length === 0) return NextResponse.json({ error: { message: 'User not found' } }, { status: 404 });
    const row = r.values[0];
    // 401 (not 403) so the client's refresh attempt fails too and it signs out.
    if (Number(row[6]) === 1) return NextResponse.json({ error: { message: 'Not authenticated', code: 'NOT_AUTHENTICATED' } }, { status: 401 });
    let preferences = {};
    try { preferences = row[5] ? JSON.parse(row[5] as string) : {}; } catch { preferences = {}; }
    // What this user may do and where: permission id -> '*' (every server) or the server ids it covers.
    // The UI uses it to show or hide controls; the API enforces it independently. Never fails the request.
    let permissions: Record<string, '*' | string[]> = {};
    try {
      permissions = await permissionMap({ userId: String(row[0]), username: String(row[1]), role: String(row[2]), authType: 'session' });
    } catch (err) {
      console.error('Permission map failed:', err);
    }
    return NextResponse.json({ data: { user: { id: row[0], username: row[1], role: row[2], display_name: row[3], email: row[4], preferences, mfa_method: row[7] || 'none', permissions } } });
  } catch (error) {
    console.error('Me error:', error);
    return internalError(error);
  }
}
