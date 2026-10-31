import { NextResponse } from 'next/server';
import type { TokenPayload } from '@/lib/auth/jwt';
import { hasPermission } from '@/lib/permissions/authorize';
import { guardedChanges, type GuardedField } from '@/lib/widgets/config-guard';

/**
 * A 403 when applying `next` would change a setting the caller may not change (see config-guard.ts), else null. The
 * permission is checked for the server the widget is on.
 */
export async function denyGuardedConfigChange(
  auth: TokenPayload, serverId: string, schema: GuardedField[] | undefined, current: unknown, next: unknown, replace = false,
): Promise<NextResponse | null> {
  for (const change of guardedChanges(schema, current, next, replace)) {
    if (!(await hasPermission(auth, change.permission, serverId))) {
      return NextResponse.json({ error: { message: `Changing "${change.label}" needs the permission "${change.permission}".`, code: 'FORBIDDEN' } }, { status: 403 });
    }
  }
  return null;
}
