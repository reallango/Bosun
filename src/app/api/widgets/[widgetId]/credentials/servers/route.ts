import { NextRequest, NextResponse } from 'next/server';
import { ok, failFrom } from '@/lib/api/response';
import { requireAuth } from '@/lib/auth/middleware';
import { serverChoices } from '@/lib/widgets/credential-access';

/** The servers a credential entry may be scoped to (the ones the caller may see). */
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  try {
    return ok({ servers: await serverChoices(auth) });
  } catch (error) {
    return failFrom(error);
  }
}
