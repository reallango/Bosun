import { NextRequest, NextResponse } from 'next/server';
import { verifyAccessToken } from '@/lib/auth/jwt';
import { rqlite } from '@/lib/db/rqlite-client';

export async function GET(request: NextRequest) {
  try {
    const accessToken = request.cookies.get('access_token')?.value;
    if (!accessToken) return NextResponse.json({ error: { message: 'Not authenticated', code: 'NOT_AUTHENTICATED' } }, { status: 401 });
    const payload = await verifyAccessToken(accessToken);
    if (!payload) return NextResponse.json({ error: { message: 'Invalid token', code: 'TOKEN_EXPIRED' } }, { status: 401 });
    const r = await rqlite.query("SELECT id, username, role, display_name, email, preferences FROM users WHERE id = ?", [payload.userId]);
    if (!r.values || r.values.length === 0) return NextResponse.json({ error: { message: 'User not found' } }, { status: 404 });
    const row = r.values[0];
    return NextResponse.json({ data: { user: { id: row[0], username: row[1], role: row[2], display_name: row[3], email: row[4], preferences: row[5] ? JSON.parse(row[5] as string) : {} } } });
  } catch (error) {
    console.error('Me error:', error);
    return NextResponse.json({ error: { message: 'Internal server error', code: 'INTERNAL_ERROR' } }, { status: 500 });
  }
}