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
        const loginUrl = new URL('/login', request.url);
        return NextResponse.redirect(loginUrl);
    }

    return NextResponse.next();
}

export const config = {
    matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};