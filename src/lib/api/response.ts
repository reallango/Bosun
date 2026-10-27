import { NextResponse } from 'next/server';

export function ok(data: unknown, init?: ResponseInit) {
  return NextResponse.json({ data }, init);
}

export function fail(message: string, status = 400, code?: string) {
  return NextResponse.json({ error: { message, code } }, { status });
}

/** Turn a thrown error (optionally carrying `status`) into an error response. */
export function failFrom(error: unknown, fallbackStatus = 500) {
  const status = (error as { status?: unknown })?.status;
  const message = error instanceof Error ? error.message : String(error);
  return fail(message, typeof status === 'number' ? status : fallbackStatus);
}