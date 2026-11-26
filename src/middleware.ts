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
        // A relative Location: behind the container's nginx, Next only knows its internal address
        // (request.url is http://localhost:3000/...), so an absolute URL built from it sends the browser there.
        // The browser resolves "/login" against the address it actually used (LAN IP, tunnel name, port).
        return new NextResponse(null, { status: 307, headers: { Location: '/login' } });
    }

    return NextResponse.next();
}

export const config = {
    matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};