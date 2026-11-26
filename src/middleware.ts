import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
    const { pathname } = request.nextUrl;

    // Allow WebSocket path (Cloudflare-compatible)
    if (pathname.startsWith('/ws/')) {
        return NextResponse.next();
    }

    // Allow public routes without auth check
    if (
        pathname.startsWith('/login') ||
        pathname.startsWith('/setup') ||
        pathname === '/forgot-password' ||
        pathname === '/reset-password' ||
        pathname.startsWith('/api/') ||
        pathname.startsWith('/_next/') ||
        pathname === '/favicon.ico'
    ) {
        return NextResponse.next();
    }

    // Check for access_token cookie existence only
    // Actual JWT verification happens in API route handlers
    const token = request.cookies.get('access_token')?.value;
    if (!token) {
        return NextResponse.redirect(loginUrl(request));
    }

    return NextResponse.next();
}

/**
 * The sign-in page at the address the browser used. Behind the container's nginx, Next only knows its internal
 * address (request.url is http://localhost:3000/...), so the origin comes from the Host header (nginx passes the
 * browser's, with the port) and X-Forwarded-Proto (set by a TLS proxy or tunnel in front). Next's middleware
 * refuses a relative Location, so it has to be absolute. Anything odd falls back to request.url.
 */
export function loginUrl(request: NextRequest): URL {
    const host = request.headers.get('host') ?? '';
    const proto = (request.headers.get('x-forwarded-proto') ?? '').split(',')[0].trim().toLowerCase();
    if (/^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+)(:\d{1,5})?$/.test(host)) {
        return new URL(`${proto === 'https' ? 'https' : 'http'}://${host}/login`);
    }
    return new URL('/login', request.url);
}

export const config = {
    matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};