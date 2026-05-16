import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { verifyAccessToken, hashToken } from '@/lib/auth/jwt';
import { rqlite } from '@/lib/db/rqlite-client';
import { getConfig } from '@/lib/db/migrations';

const PUBLIC_PATHS = ['/login', '/setup', '/api/health', '/api/auth/login', '/api/auth/refresh', '/api/auth/setup', '/_next', '/favicon.ico'];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Allow public paths
  if (PUBLIC_PATHS.some(p => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // Check if setup is complete
  try {
    const setupComplete = await getConfig('app.setup_complete');
    if (setupComplete !== 'true') {
      return NextResponse.redirect(new URL('/setup', request.url));
    }
  } catch {
    // Database not ready yet, allow through
    return NextResponse.next();
  }

  // Check access token
  const accessToken = request.cookies.get('access_token')?.value;
  const refreshToken = request.cookies.get('refresh_token')?.value;

  if (!accessToken && !refreshToken) {
    return NextResponse.redirect(new URL('/login', request.url));
  }

  // Verify access token
  if (accessToken) {
    const payload = await verifyAccessToken(accessToken);
    if (payload) {
      return NextResponse.next();
    }
  }

  // Try refresh
  if (refreshToken) {
    const refreshHash = hashToken(refreshToken);
    const now = new Date().toISOString();
    
    const session = await rqlite.query(
      `SELECT user_id FROM sessions WHERE token_hash = '${refreshHash}' AND expires_at > '${now}'`
    );

    if (session.values.length > 0) {
      // Will redirect to API refresh
      return NextResponse.redirect(new URL('/api/auth/refresh', request.url));
    }
  }

  return NextResponse.redirect(new URL('/login', request.url));
}

export const config = {
  matcher: ['/((?!api|_next|favicon.ico).*)']
};