import { NextRequest, NextResponse } from 'next/server';
import { verifyAccessToken, TokenPayload } from './jwt';

export async function requireAuth(request: NextRequest): Promise<TokenPayload | NextResponse> {
  const accessToken = request.cookies.get('access_token')?.value;
  if (!accessToken) {
    return NextResponse.json(
      { data: null, error: { message: 'Not authenticated', code: 'NOT_AUTHENTICATED' } },
      { status: 401 }
    );
  }

  const payload = await verifyAccessToken(accessToken);
  if (!payload) {
    return NextResponse.json(
      { data: null, error: { message: 'Invalid or expired token', code: 'TOKEN_EXPIRED' } },
      { status: 401 }
    );
  }

  return payload;
}

export function requireRole(payload: TokenPayload, requiredRole: 'admin' | 'operator' | 'viewer'): NextResponse | null {
  const roleHierarchy = { admin: 3, operator: 2, viewer: 1 };
  const userLevel = roleHierarchy[payload.role as keyof typeof roleHierarchy] || 0;
  const requiredLevel = roleHierarchy[requiredRole];

  if (userLevel < requiredLevel) {
    return NextResponse.json(
      { data: null, error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } },
      { status: 403 }
    );
  }
  return null;
}