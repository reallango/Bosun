import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireRole } from '@/lib/auth/middleware';
import { ok, fail, internalError } from '@/lib/api/response';
import { listForViewer, markRead, notify } from '@/lib/notifications/store';

/** The notifications the caller may see (newest first). `?unread=true` for unread only. */
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  try {
    const unreadOnly = new URL(request.url).searchParams.get('unread') === 'true';
    return ok({ notifications: await listForViewer(auth, { unreadOnly }) });
  } catch (error) {
    return internalError(error);
  }
}

/** Post a notification by hand (Full access): { title, message, severity?, server_id?, link? }. */
export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const denied = requireRole(auth, 'admin');
  if (denied) return denied;
  let body: { title?: unknown; message?: unknown; severity?: unknown; server_id?: unknown; link?: unknown };
  try { body = await request.json(); } catch { return fail('Invalid JSON body'); }
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const message = typeof body.message === 'string' ? body.message : '';
  if (!title) return fail('title required');
  const severity = ['info', 'success', 'warning', 'critical'].includes(String(body.severity)) ? body.severity as 'info' : 'info';
  try {
    await notify({ kind: 'alert', severity, title, message, serverId: typeof body.server_id === 'string' ? body.server_id : null,
      link: typeof body.link === 'string' ? body.link : null });
    return ok({ message: 'Notification created' }, { status: 201 });
  } catch (error) {
    return internalError(error);
  }
}

/** Mark read: { read: true } marks every visible notification read; { id, read|is_read: true } marks one. */
export async function PATCH(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  let body: { id?: unknown; read?: unknown; is_read?: unknown };
  try { body = await request.json(); } catch { return fail('Invalid JSON body'); }
  if (!(body.read ?? body.is_read)) return fail('Only { read: true } is supported');
  try {
    const updated = await markRead(auth, typeof body.id === 'string' && body.id ? body.id : undefined);
    return ok({ updated });
  } catch (error) {
    return internalError(error);
  }
}
