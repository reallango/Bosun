/**
 * Restore a database backup uploaded as multipart/form-data (`file`, `replace`).
 * Admin-only. `replace=true` clears each table first and is required for the
 * sqlite/sql formats, which replace the whole database.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireUserLevel } from '@/lib/auth/middleware';
import { importDatabase } from '@/lib/db/backup';
import { logAudit } from '@/lib/audit/logger';
import { ok, fail } from '@/lib/api/response';

export async function POST(request: NextRequest) {
  // A signed-in admin only, never an API key: a backup holds password hashes and secrets, and a
  // restore can rewrite users and keys.
  const auth = await requireUserLevel(request, 'admin');
  if (auth instanceof NextResponse) return auth;

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
