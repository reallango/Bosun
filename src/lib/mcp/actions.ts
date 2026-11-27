/**
 * Run generated widget tools through the same library functions as the REST widget routes: the dataset loader and
 * runWidgetAction, with the same permission, target, confirmation, rate-limit and audit behaviour.
 */
import type { NextResponse } from 'next/server';
import type { TokenPayload } from '@/lib/auth/jwt';
import type { LoadedSpec } from '@/lib/widgets/runtime/execute';
import type { ActionSpec } from '@/lib/widgets/runtime/spec';
import type { ResourceContext } from '@/lib/permissions/evaluate';
import type { ActionBody } from '@/lib/widgets/runtime/run-action';
import type { ResourceFields, ResourceTarget } from '@/lib/widgets/runtime/resources';
import type { CatalogTool, ToolResult } from './types';
import { errorResult, formatData, textResult, truncate } from './format';
import { errorText, toolErrorFromBody, toolErrorFromResponse } from './errors';

export interface WidgetDeps {
  loadWidgetSpec(type: string): Promise<LoadedSpec | null>;
  serverVisible(auth: TokenPayload, serverId: string): Promise<boolean>;
  requirePermission(auth: TokenPayload, permission: string, serverId?: string | null, resource?: ResourceContext | null): Promise<NextResponse | null>;
  viewFilter(auth: TokenPayload, permission: string, serverId: string, fields: ResourceFields | undefined): Promise<'all' | ((r: ResourceContext) => boolean) | null>;
  loadDataset(serverId: string, loaded: LoadedSpec, datasetId: string, rawArgs: unknown): Promise<{ data: unknown; collectedAt: string }>;
  filterRows(data: unknown, fields: ResourceFields, allow: 'all' | ((r: ResourceContext) => boolean)): unknown;
  resolveTarget(serverId: string, loaded: LoadedSpec, target: ResourceTarget, value: unknown): Promise<ResourceContext>;
  runWidgetAction(auth: TokenPayload, serverId: string, loaded: LoadedSpec, action: ActionSpec, body: ActionBody, opts?: { ip?: string }): Promise<NextResponse>;
  openTerminalAction(auth: TokenPayload, serverId: string, loaded: LoadedSpec, action: ActionSpec, ref: unknown): Promise<NextResponse>;
  consumeActionRateLimit(userId: string): { allowed: boolean };
}

export interface ActionContext {
  auth: TokenPayload;
  ip?: string;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

/** The same confirmation rule as the REST action route: a confirmed action needs `confirm: true`. */
export function confirmProblem(action: Pick<ActionSpec, 'confirm'>, confirm: unknown): string | null {
  if (!action.confirm) return null;
  if (confirm === true) return null;
  const detail = action.confirm.text ? ` — ${action.confirm.text}` : '';
  return `Confirmation required: ${action.confirm.title}${detail} (send confirm: true)`;
}

function actionBody(action: ActionSpec, args: Record<string, unknown>): ActionBody {
  if (action.kind === 'terminal') return { ref: args.ref };
  const params: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (k !== 'server_id' && k !== 'confirm' && k !== 'widget_id') params[k] = v;
  }
  return { params, confirm: args.confirm, ...(typeof args.widget_id === 'string' ? { widgetId: args.widget_id } : {}) };
}

async function responseResult(response: NextResponse, fallback: string): Promise<ToolResult> {
  let body: unknown = null;
  try { body = await response.json(); } catch { /* not JSON */ }
  if (!response.ok) {
    const error = body && typeof body === 'object' ? (body as { error?: Record<string, unknown> }).error : undefined;
    return errorResult(toolErrorFromBody(body, fallback), error ? { error } : undefined);
  }
  return textResult(fallback, body && typeof body === 'object' ? body as Record<string, unknown> : { body });
}

export async function callWidgetDataset(
  ctx: ActionContext, tool: CatalogTool, args: Record<string, unknown>, deps: WidgetDeps,
): Promise<ToolResult> {
  const serverId = requiredString(args.server_id, 'server_id');
  const loaded = await deps.loadWidgetSpec(tool.widgetType!);
  if (!loaded) return errorResult(`Widget "${tool.widgetType}" is no longer installed.`);
  const datasetId = tool.datasetId!;
  const ds = loaded.spec.datasets?.[datasetId];
  if (!ds) return errorResult(`Dataset "${datasetId}" is no longer available on ${tool.widgetType}.`);
  if (!(await deps.serverVisible(ctx.auth, serverId))) return errorResult(`Server not found: ${serverId}`);

  const rawArgs: Record<string, unknown> = { ...args };
  delete rawArgs.server_id;

  let result: { data: unknown; collectedAt: string };
  if (ds.target) {
    const resource = await deps.resolveTarget(serverId, loaded, ds.target, rawArgs[ds.target.param]);
    const denied = await deps.requirePermission(ctx.auth, ds.permission, serverId, resource);
    if (denied) return errorResult(await toolErrorFromResponse(denied, 'Not permitted'));
    result = await deps.loadDataset(serverId, loaded, datasetId, rawArgs);
  } else {
    const view = await deps.viewFilter(ctx.auth, ds.permission, serverId, ds.resources);
    if (!view) {
      const denied = await deps.requirePermission(ctx.auth, ds.permission, serverId);
      return denied
        ? errorResult(await toolErrorFromResponse(denied, 'Not permitted'))
        : errorResult('Not permitted');
    }
    result = await deps.loadDataset(serverId, loaded, datasetId, rawArgs);
    if (view !== 'all') result = { ...result, data: deps.filterRows(result.data, ds.resources!, view) };
  }

  const formatted = formatData(result.data);
  const header = [
    `Dataset "${datasetId}" of ${tool.widgetDisplayName ?? tool.widgetType} on ${serverId}`,
    result.collectedAt ? `Collected: ${result.collectedAt}` : undefined,
  ].filter(Boolean).join('\n');
  return textResult(`${header}\n\n${formatted.text}`, {
    widget_type: tool.widgetType,
    dataset: datasetId,
    server_id: serverId,
    collected_at: result.collectedAt,
    data: formatted.structured,
    truncated: formatted.truncated,
    ...(formatted.total !== null ? { total: formatted.total } : {}),
  });
}

export async function callWidgetAction(
  ctx: ActionContext, tool: CatalogTool, args: Record<string, unknown>, deps: WidgetDeps,
): Promise<ToolResult> {
  const serverId = requiredString(args.server_id, 'server_id');
  const loaded = await deps.loadWidgetSpec(tool.widgetType!);
  if (!loaded) return errorResult(`Widget "${tool.widgetType}" is no longer installed.`);
  const action = loaded.spec.actions.find(a => a.id === tool.actionId);
  if (!action) return errorResult(`Action "${tool.actionId}" is no longer available on ${tool.widgetType}.`);
  if (!(await deps.serverVisible(ctx.auth, serverId))) return errorResult(`Server not found: ${serverId}`);

  const body = actionBody(action, args);
  if (action.target) {
    const value = action.kind === 'terminal' ? body.ref : (body.params as Record<string, unknown> | undefined)?.[action.target.param];
    const resource = await deps.resolveTarget(serverId, loaded, action.target, value);
    const denied = await deps.requirePermission(ctx.auth, action.permission, serverId, resource);
    if (denied) return errorResult(await toolErrorFromResponse(denied, 'Not permitted'));
  } else {
    const denied = await deps.requirePermission(ctx.auth, action.permission, serverId);
    if (denied) return errorResult(await toolErrorFromResponse(denied, 'Not permitted'));
  }

  if (action.kind === 'screen') return errorResult('This action only opens a screen in the web UI.');
  if (action.kind === 'terminal') {
    const response = await deps.openTerminalAction(ctx.auth, serverId, loaded, action, body.ref);
    const result = await responseResult(response, `${action.label}: terminal token`);
    if (!result.isError && response.ok) {
      const data = result.structuredContent?.data as Record<string, unknown> | undefined;
      const token = typeof data?.token === 'string' ? data.token : '';
      const path = typeof data?.path === 'string' ? data.path : '/ws/api-terminal';
      const expires = data?.expiresInSec !== undefined ? ` (expires in ${data.expiresInSec}s)` : '';
      return textResult(`${action.label}: connect to ${path}?token=${token}${expires}`, result.structuredContent);
    }
    return result;
  }

  const confirm = confirmProblem(action, body.confirm);
  if (confirm) return errorResult(confirm);

  if (!deps.consumeActionRateLimit(ctx.auth.userId).allowed) return errorResult('Too many actions, slow down (RATE_LIMITED).');

  const response = await deps.runWidgetAction(ctx.auth, serverId, loaded, action, body, { ip: ctx.ip });
  let json: unknown = null;
  try { json = await response.json(); } catch { /* not JSON */ }
  if (!response.ok) {
    const error = json && typeof json === 'object' ? (json as { error?: Record<string, unknown> }).error : undefined;
    return errorResult(toolErrorFromBody(json, `Action failed (HTTP ${response.status})`), error ? { error } : undefined);
  }
  const data: Record<string, unknown> = json && typeof json === 'object' && 'data' in json
    ? (json as { data?: Record<string, unknown> }).data ?? {}
    : {};
  if (typeof data.jobId === 'string') {
    return textResult(
      `Job started: ${data.jobId} (${String(data.status ?? 'running')}).\nUse job_wait with job_id="${data.jobId}" to wait for it.`,
      { ...data, job_id: data.jobId },
    );
  }
  const lines: string[] = [];
  if (typeof data.message === 'string' && data.message) lines.push(data.message);
  lines.push(data.success === true ? 'Success.' : data.success === false ? 'Failed.' : 'Done.');
  if (data.exitCode !== undefined) lines.push(`Exit code: ${String(data.exitCode)}`);
  if (data.timedOut === true) lines.push('Timed out.');
  if (typeof data.output === 'string' && data.output) lines.push(`Output:\n${truncate(data.output, 4000)}`);
  if (typeof data.error === 'string' && data.error) lines.push(`Error:\n${truncate(data.error, 2000)}`);
  return textResult(lines.join('\n'), data);
}

export { errorText };
