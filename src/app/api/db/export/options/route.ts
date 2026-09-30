import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireRole } from '@/lib/auth/middleware';
import { BACKUP_TABLES, LARGE_TABLES, BACKUP_FORMAT_VERSION } from '@/lib/db/backup';
import { SCHEMA_VERSION } from '@/lib/db/migrations';
import { ok, fail } from '@/lib/api/response';

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const roleError = requireRole(auth, 'viewer');
  if (roleError) return roleError;

  try {
    return ok({
      formats: [
        { id: 'json', label: 'JSON document', description: 'Portable, inspectable, supports table scope and secret redaction' },
        { id: 'sqlite', label: 'SQLite snapshot', description: "rqlite's recommended full backup. Secrets cannot be redacted" },
        { id: 'sql', label: 'SQL dump', description: 'Text dump of schema and data. Secrets cannot be redacted' },
      ],
      tables: BACKUP_TABLES,
      largeTables: LARGE_TABLES,
      formatVersion: BACKUP_FORMAT_VERSION,
      schemaVersion: SCHEMA_VERSION,
    });
  } catch (error) {
    console.error('Export options error:', error);
    return fail('Internal server error', 500, 'INTERNAL_ERROR');
  }
}
