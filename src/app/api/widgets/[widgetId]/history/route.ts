import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireRole } from '@/lib/auth/middleware';
import { rqlite } from '@/lib/db/rqlite-client';

// Most recent samples returned to the History viewer. The series is pruned to
// the widget's TTL, but a long TTL at a short interval could still produce a
// large payload, so cap it and keep the newest window.
const MAX_SAMPLES = 2000;

export async function GET(request: NextRequest, { params }: { params: Promise<{ widgetId: string }> }) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const roleError = requireRole(auth as any, 'viewer');
  if (roleError) return roleError;
  const { widgetId } = await params;

  try {
    const widgetRes = await rqlite.query('SELECT id FROM widgets WHERE id = ?', [widgetId]);
    if (!widgetRes.values?.length) {
      return NextResponse.json({ error: { message: 'Widget not found' } }, { status: 404 });
    }

    // Newest first so the LIMIT keeps the most recent window, then reverse to
    // ascending time order for charting.
    const result = await rqlite.query(
      `SELECT data, collected_at FROM widget_history WHERE widget_id = ? ORDER BY collected_at DESC LIMIT ?`,
      [widgetId, MAX_SAMPLES]
    );

    const samples = (result.values || [])
      .map(([data, collectedAt]) => {
        try {
          return { collected_at: collectedAt as string, data: JSON.parse(data as string) };
        } catch {
          return null;
        }
      })
      .filter((s): s is { collected_at: string; data: unknown } => s !== null)
      .reverse();

    return NextResponse.json({ data: { samples } });
  } catch (error) {
    console.error('Widget history error:', error);
    return NextResponse.json({ error: { message: String(error).substring(0, 200) } }, { status: 500 });
  }
}
