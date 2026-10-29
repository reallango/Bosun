import { NextRequest, NextResponse } from 'next/server';
import { requireUserLevel } from '@/lib/auth/middleware';
import { fullCatalog, RISK_LABEL } from '@/lib/permissions/catalog';
import { registeredPermissionDefs } from '@/lib/permissions/store';
import { internalError, ok } from '@/lib/api/response';

/**
 * The permission catalog: system and core permissions plus any registered by
 * installed widgets. Used by the group editor; Full access, signed-in users only.
 */
export async function GET(request: NextRequest) {
  const auth = await requireUserLevel(request, 'admin');
  if (auth instanceof NextResponse) return auth;
  try {
    return ok({ permissions: fullCatalog(await registeredPermissionDefs()), risk_labels: RISK_LABEL });
  } catch (error) {
    console.error('Permission catalog error:', error);
    return internalError(error);
  }
}
