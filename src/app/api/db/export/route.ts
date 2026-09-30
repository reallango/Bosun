/**
 * Download a database backup as a file attachment.
 *
 * Query params: `format` (json|sqlite|sql), `tables` (comma-separated, JSON only),
 * `includeSecrets` and `excludeLarge`. Admin-only.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireRole } from '@/lib/auth/middleware';
import { exportDatabase, BackupFormat } from '@/lib/db/backup';
import { logAudit } from '@/lib/audit/logger';
import { fail } from '@/lib/api/response';

const VALID_FORMATS: BackupFormat[] = ['json', 'sqlite', 'sql'];

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const roleError = requireRole(auth, 'admin');
  if (roleError) return roleError;

  try {
    const params = request.nextUrl.searchParams;
    const formatParam = params.get('format') || 'json';
    if (!VALID_FORMATS.includes(formatParam as BackupFormat)) {
      return fail(`Unknown format: ${formatParam}`, 400, 'INVALID_FORMAT');
    }
    const format = formatParam as BackupFormat;

    const tablesParam = params.get('tables');
    const result = await exportDatabase({
      format,
      tables: tablesParam ? tablesParam.split(',').filter(Boolean) : undefined,
      includeSecrets: params.get('includeSecrets') === 'true',
      excludeLarge: params.get('excludeLarge') === 'true',
    });

    await logAudit({
      userId: auth.userId,
      action: 'database.export',
      status: 'success',
      details: `${result.format} export`,
    });

    const body =
      typeof result.body === 'string' || result.body instanceof Uint8Array
        ? (result.body as BodyInit)
        : JSON.stringify(result.body, null, 2);

    return new NextResponse(body, {
      status: 200,
      headers: {
        'Content-Type': result.contentType,
        'Content-Disposition': `attachment; filename="${result.filename}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    console.error('Export error:', error);
    return fail(String(error), 500, 'EXPORT_FAILED');
  }
}
