import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireRole } from '@/lib/auth/middleware';
import { importDatabase } from '@/lib/db/backup';
import { logAudit } from '@/lib/audit/logger';
import { ok, fail } from '@/lib/api/response';

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const roleError = requireRole(auth, 'admin');
  if (roleError) return roleError;

  try {
    const formData = await request.formData().catch(() => null);
    const file = formData?.get('file');
    if (!(file instanceof File)) {
      return fail('Missing backup file', 400, 'NO_FILE');
    }
    const replace = formData?.get('replace') === 'true';

    const data = new Uint8Array(await file.arrayBuffer());
    const result = await importDatabase(data, { replace });

    await logAudit({
      userId: auth.userId,
      action: 'database.import',
      status: 'success',
      details: `${result.format} import (replace=${replace})`,
    });

    return ok(result);
  } catch (error) {
    console.error('Import error:', error);
    return fail(String(error), 400, 'IMPORT_FAILED');
  }
}
