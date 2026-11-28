import { NextRequest, NextResponse } from 'next/server';
import { ok, fail, failFrom } from '@/lib/api/response';
import { requireAuth, clientIp } from '@/lib/auth/middleware';
import { logAudit, AuditActions } from '@/lib/audit/logger';
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';
import { getInstalledPackage } from '@/lib/widgets/package-store';
import {
  createCredential, deleteCredential, getCredentialEntry, listCredentialEntries, updateCredential,
} from '@/lib/widgets/credentials';
import { canManageKind, canViewKind, kindForType, manageTargets, publicKind, requireKindManage } from '@/lib/widgets/credential-access';
import type { CredentialKindDef } from '@/lib/widgets/credentials-schema';

/**
 * The credentials of a widget type's package (see credentials-schema.ts). A read returns the public fields, whether
 * each secret is set and its last use — never a secret value. Writes take `fields` (public) and `secrets` (write-only;
 * leave one out or send "" to keep it unchanged, or null to clear it) and the servers the entry applies to.
 *
 *   GET    ?kind=<id>&server_id=<id>   every kind the caller may view (or just one)
 *   POST   { kind, name, fields, secrets, servers, isDefault }
 *   PUT    { id, kind, name, fields, secrets, servers, isDefault }
 *   DELETE ?kind=<id>&id=<entry id>
 */
async function packageOf(type: string): Promise<{ packageId: string; kinds: CredentialKindDef[] } | null> {
  const row = rowsToObjects(await rqlite.query('SELECT package_id FROM custom_widgets WHERE type = ? AND package_id IS NOT NULL', [type]))[0];
  if (!row) return null;
  const found = await getInstalledPackage(String(row.package_id));
  return found ? { packageId: found.pkg.id, kinds: found.pkg.manifest.credentials } : null;
}

async function body(request: NextRequest): Promise<Record<string, unknown>> {
  try { return await request.json(); } catch { return {}; }
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ widgetId: string }> }) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const { widgetId: type } = await params;
  try {
    const url = new URL(request.url);
    const kindId = url.searchParams.get('kind');
    const serverId = url.searchParams.get('server_id') ?? undefined;
    const ctx = kindId ? await kindForType(type, kindId) : null;
    if (kindId && !ctx) return fail('Unknown credential kind', 404, 'NOT_FOUND');
    const pkg = ctx ?? (await packageOf(type));
    if (!pkg) return fail('Widget type not found', 404, 'NOT_FOUND');
    const kinds = ctx ? [ctx.kind] : pkg.kinds;
    const items = [];
    for (const kind of kinds) {
      if (!(await canViewKind(auth, kind))) {
        if (kindId) return fail('Not permitted to view these credentials', 403, 'FORBIDDEN');
        continue;
      }
      items.push({
        ...publicKind(kind),
        entries: await listCredentialEntries(pkg.packageId, kind, serverId),
        canManage: await canManageKind(auth, kind),
      });
    }
    return ok({ kinds: items, server_id: serverId ?? null });
  } catch (error) {
    return failFrom(error);
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ widgetId: string }> }) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const { widgetId: type } = await params;
  try {
    const b = await body(request);
    const ctx = await kindForType(type, typeof b.kind === 'string' ? b.kind : '');
    if (!ctx) return fail('Unknown credential kind', 404, 'NOT_FOUND');
    const servers = Array.isArray(b.servers) ? b.servers.filter((s): s is string => typeof s === 'string') : [];
    const denied = await requireKindManage(auth, ctx.kind, servers);
    if (denied) return denied;
    const entry = await createCredential(ctx.packageId, ctx.kind, {
      name: b.name, fields: b.fields, secrets: b.secrets, servers, isDefault: b.isDefault,
    }, auth.userId);
    await logAudit({ userId: auth.userId, action: AuditActions.WIDGET_CREDENTIAL, status: 'success', ipAddress: clientIp(request) ?? undefined, details: `Created ${ctx.kind.id} credential "${entry.name}" of ${ctx.packageId}` });
    return ok({ entry }, { status: 201 });
  } catch (error) {
    return failFrom(error);
  }
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ widgetId: string }> }) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const { widgetId: type } = await params;
  try {
    const b = await body(request);
    const id = typeof b.id === 'string' ? b.id : '';
    const ctx = await kindForType(type, typeof b.kind === 'string' ? b.kind : '');
    if (!ctx || !id) return fail('Unknown credential kind', 404, 'NOT_FOUND');
    const existing = await getCredentialEntry(ctx.packageId, ctx.kind, id);
    if (!existing) return fail('Credential not found', 404, 'NOT_FOUND');
    const nextServers = Array.isArray(b.servers) ? b.servers.filter((s): s is string => typeof s === 'string') : null;
    const denied = await requireKindManage(auth, ctx.kind, manageTargets(existing.servers, nextServers));
    if (denied) return denied;
    const entry = await updateCredential(ctx.packageId, ctx.kind, id, {
      name: b.name, fields: b.fields, secrets: b.secrets, servers: b.servers, isDefault: b.isDefault,
    }, auth.userId);
    await logAudit({ userId: auth.userId, action: AuditActions.WIDGET_CREDENTIAL, status: 'success', ipAddress: clientIp(request) ?? undefined, details: `Updated ${ctx.kind.id} credential "${entry.name}" of ${ctx.packageId}` });
    return ok({ entry });
  } catch (error) {
    return failFrom(error);
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ widgetId: string }> }) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const { widgetId: type } = await params;
  try {
    const url = new URL(request.url);
    const ctx = await kindForType(type, url.searchParams.get('kind') ?? '');
    if (!ctx) return fail('Unknown credential kind', 404, 'NOT_FOUND');
    const id = url.searchParams.get('id') ?? '';
    const existing = await getCredentialEntry(ctx.packageId, ctx.kind, id);
    if (!existing) return fail('Credential not found', 404, 'NOT_FOUND');
    const denied = await requireKindManage(auth, ctx.kind, existing.servers);
    if (denied) return denied;
    await deleteCredential(ctx.packageId, id);
    await logAudit({ userId: auth.userId, action: AuditActions.WIDGET_CREDENTIAL, status: 'success', ipAddress: clientIp(request) ?? undefined, details: `Deleted ${ctx.kind.id} credential "${existing.name}" of ${ctx.packageId}` });
    return ok({ deleted: true });
  } catch (error) {
    return failFrom(error);
  }
}
