import { NextResponse } from 'next/server';

// Catch-all for unknown /api/* paths. Without this, Next's App Router answers
// unmatched API paths with the HTML not-found page, which breaks clients that
// call `res.json()` (they surface "Unexpected token '<'"). This guarantees the
// API contract: every /api/* request returns JSON, including 404s.
function notFound() {
  return NextResponse.json(
    { error: { message: 'Not found', code: 'NOT_FOUND' } },
    { status: 404 }
  );
}

export const GET = notFound;
export const POST = notFound;
export const PATCH = notFound;
export const PUT = notFound;
export const DELETE = notFound;
export const HEAD = notFound;
export const OPTIONS = notFound;
