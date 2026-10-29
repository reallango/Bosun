import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/middleware';
import { requirePermission } from '@/lib/permissions/authorize';
import { describeOllama, runOllamaAction, OllamaManageError, type OllamaAction } from '@/lib/ollama/manage';
import { consumeActionRateLimit } from '@/lib/utils/rate-limiter';
import { logAudit, AuditActions } from '@/lib/audit/logger';
import { ok, fail, failFrom } from '@/lib/api/response';

const ACTIONS: OllamaAction[] = ['start', 'stop', 'restart', 'set_startup', 'set_restart_policy', 'install', 'update'];
/** Actions that interrupt Ollama or change the host a lot: the caller has to confirm them. */
const NEEDS_CONFIRM: OllamaAction[] = ['stop', 'restart', 'install', 'update'];

/** How Ollama is installed on this server, whether a newer release exists, and the install or update job in progress. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ serverId: string }> }) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const { serverId } = await params;
  const denied = await requirePermission(auth, 'ollama.view', serverId);
  if (denied) return denied;
  try {
    return ok(await describeOllama(serverId));
  } catch (error) {
    if (error instanceof OllamaManageError) return fail(error.message, error.status, error.code);
    return failFrom(error);
  }
}

/**
 * Install, update or control Ollama on the server. Needs `ollama.service` (Full access by default).
 * Body: { action, value?, method?, version?, confirm? }. `value` is the startup method (set_startup) or the
 * restart policy (set_restart_policy). Install and update answer 202 and run as a job; poll GET for it.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ serverId: string }> }) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const { serverId } = await params;
  const denied = await requirePermission(auth, 'ollama.service', serverId);
  if (denied) return denied;
  let body: { action?: unknown; value?: unknown; method?: unknown; version?: unknown; confirm?: unknown };
  try { body = await request.json(); } catch { return fail('Invalid JSON body'); }
  const action = body.action as OllamaAction;
  if (!ACTIONS.includes(action)) return fail('Unknown action');
  if (NEEDS_CONFIRM.includes(action) && body.confirm !== true) return fail('Confirmation required', 400, 'CONFIRM_REQUIRED');
  const limit = consumeActionRateLimit(auth.userId);
  if (!limit.allowed) return fail('Too many actions, slow down', 429, 'RATE_LIMITED');
  try {
    const result = await runOllamaAction(serverId, auth.userId, action, { value: body.value, method: body.method, version: body.version });
    if (!result.job) {
      await logAudit({ userId: auth.userId, serverId, action: AuditActions.OLLAMA_SERVICE, status: 'success',
        details: JSON.stringify({ action, value: typeof body.value === 'string' ? body.value : undefined }) });
      return ok({ message: result.message });
    }
    await logAudit({ userId: auth.userId, serverId, action: AuditActions.OLLAMA_SERVICE, status: 'pending', details: JSON.stringify({ action, started: true }) });
    return ok({ job: result.job }, { status: 202 });
  } catch (error) {
    if (error instanceof OllamaManageError) return fail(error.message, error.status, error.code);
    const status = (error as { status?: number })?.status;
    if (status === 400) return fail(error instanceof Error ? error.message : 'Invalid request');
    return failFrom(error);
  }
}
