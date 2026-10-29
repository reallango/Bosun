import { NextRequest, NextResponse } from 'next/server';
import { ok, failFrom } from '@/lib/api/response';
import { ALLOWED_REFS, SOURCE_REPO } from '@/lib/widgets/package-source';
import { requirePackageAdmin, configuredRef, listAllInstalled } from '@/lib/widgets/package-routes';

/** Installed widget packages (System widgets first) and where packages are listed from. Full access, signed-in users only. */
export async function GET(request: NextRequest) {
  const auth = await requirePackageAdmin(request);
  if (auth instanceof NextResponse) return auth;
  try {
    return ok({ installed: await listAllInstalled(), source: { repo: SOURCE_REPO, ref: await configuredRef(), refs: ALLOWED_REFS } });
  } catch (error) {
    return failFrom(error);
  }
}
