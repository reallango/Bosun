import { NextResponse } from 'next/server';

export function ok(data: unknown, init?: ResponseInit) {
  return NextResponse.json({ data }, init);
}

export function fail(message: string, status = 400, code?: string) {
  return NextResponse.json({ error: { message, code } }, { status });
}