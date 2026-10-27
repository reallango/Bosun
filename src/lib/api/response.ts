import { NextResponse } from 'next/server';

export function ok(data: unknown, init?: ResponseInit) {
  return NextResponse.json({ data }, init);
}

export function fail(message: string, status = 400, code?: string) {
  return NextResponse.json({ error: { message, code } }, { status });
}

/** Turn a thrown error (optionally carrying `status`) into an error response. */
export function failFrom(error: unknown, fallbackStatus = 500) {
  const { status, code } = (error as { status?: unknown; code?: unknown }) || {};
  const message = error instanceof Error ? error.message : String(error);
  return fail(message, typeof status === 'number' ? status : fallbackStatus, typeof code === 'string' ? code : undefined);
}
/**
 * Generic 500 for unexpected errors, except "the database cluster has no
 * leader", which becomes a 503 with an explanation the UI can show.
 */
export function internalError(error: unknown) {
  if ((error as { code?: unknown })?.code === 'NO_QUORUM') {
    return fail((error as Error).message, 503, 'NO_QUORUM');
  }
  return fail('Internal server error', 500, 'INTERNAL_ERROR');
}
