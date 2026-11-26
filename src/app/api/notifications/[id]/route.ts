import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireRole } from '@/lib/auth/middleware';
import { ok, fail, internalError } from '@/lib/api/response';
import { dismiss, markRead, restore } from '@/lib/notifications/store';

type Ctx = { params: Promise<{ id: string }> };

/**
 * Mark one notification read: { read: true }.
 * Put a dismissed notification back in the bell: { dismissed: false } (or { restore: true }).
 */
export async function PATCH(request: NextRequest, { params }: Ctx) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  let body: { read?: unknown; is_read?: unknown; dismissed?: unknown; restore?: unknown };
  try { body = await request.json(); } catch { return fail('Invalid JSON body'); }
  if (body.dismissed === false || body.restore === true) {
    const denied = requireRole(auth, 'operator');
    if (denied) return denied;
    try {
      return (await restore(auth, id)) ? ok({ restored: true }) : fail('Notification not found', 404, 'NOT_FOUND');
    } catch (error) {
      return internalError(error);
    }
  }
  if (!(body.read ?? body.is_read)) return fail('Only { read: true } or { dismissed: false } is supported');
  try {
    const updated = await markRead(auth, id);
    return updated ? ok({ updated }) : fail('Notification not found', 404, 'NOT_FOUND');
  } catch (error) {
    return internalError(error);
  }
}

/** Dismiss (hide) one notification. The table is shared, so this hides it for everyone: operators and up. */
export async function DELETE(request: NextRequest, { params }: Ctx) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const denied = requireRole(auth, 'operator');
  if (denied) return denied;
  const { id } = await params;
  try {
    return (await dismiss(auth, id)) ? ok({ dismissed: true }) : fail('Notification not found', 404, 'NOT_FOUND');
  } catch (error) {
    return internalError(error);
  }
}
