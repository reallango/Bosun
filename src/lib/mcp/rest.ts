/**
 * Generic REST adapter for MCP tools.
 *
 * A tool declares a route + method. This adapter builds a NextRequest for that route with the MCP caller's own
 * Authorization/Cookie headers and invokes the route handler in-process. Everything the route does (authentication,
 * permission checks, resource limits, rate limiting, audit logging, validation) therefore happens exactly once and
 * exactly as it does for a REST client. Nothing is duplicated here.
 */
import { NextRequest } from 'next/server';
import type { ActionContext } from './actions';
import type { CatalogTool, RestQueryParam, ToolResult } from './types';
import { errorResult, textResult, truncate } from './format';
import { toolErrorFromBody } from './errors';
import { ROUTE_MODULES } from './rest-routes';

const MAX_BINARY_BYTES = 8 * 1024 * 1024;

/** An object that both awaits like a Promise and exposes its fields (Next 14/15 route handlers use both). */
function thenableParams<T extends Record<string, string>>(obj: T): Promise<T> & T {
  return Object.assign(Promise.resolve(obj), obj);
}

function queryValue(value: unknown, spec: RestQueryParam): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'boolean') {
    return value ? spec.trueValue ?? 'true' : spec.falseValue ?? 'false';
  }
  return String(value);
}

function buildQuery(args: Record<string, unknown>, specs: Array<string | RestQueryParam> | undefined): string {
  if (!specs?.length) return '';
  const params = new URLSearchParams();
  for (const raw of specs) {
    const spec: RestQueryParam = typeof raw === 'string' ? { arg: raw } : raw;
    const value = queryValue(args[spec.arg], spec);
    if (value !== null) params.set(spec.param ?? spec.arg, value);
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

function buildPath(route: string, args: Record<string, unknown>, mapping: Record<string, string> | undefined): string {
  return route.replace(/\[([^\]]+)\]/g, (_, param: string) => {
    const argName = mapping?.[param];
    if (!argName) throw new Error(`Tool does not say which argument fills the "${param}" route parameter`);
    const value = args[argName];
    if (typeof value !== 'string' && typeof value !== 'number') throw new Error(`${argName} is required`);
    return encodeURIComponent(String(value));
  });
}

function bodyOf(tool: CatalogTool, args: Record<string, unknown>): Record<string, unknown> | null {
  const spec = tool.rest!;
  const mode = spec.body ?? (spec.method === 'GET' || spec.method === 'DELETE' ? 'none' : 'rest');
  if (mode === 'none') return null;
  if (spec.bodyRoot) {
    const root = args[spec.bodyRoot];
    if (!root || typeof root !== 'object' || Array.isArray(root)) throw new Error(`${spec.bodyRoot} must be an object`);
    return root as Record<string, unknown>;
  }
  if (mode === 'all') return { ...args };
  const used = new Set<string>([
    ...Object.values(spec.path ?? {}),
    ...(spec.query ?? []).map(q => (typeof q === 'string' ? q : q.arg)),
    ...(spec.binary ? ['content_base64', 'filename', 'content_type'] : []),
  ]);
  if (!spec.keepConfirm) used.add('confirm');
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) if (!used.has(k)) out[k] = v;
  return out;
}

function base64Bytes(value: unknown, name: string): Uint8Array {
  if (typeof value !== 'string' || !value) throw new Error(`${name} is required (base64 text)`);
  const buf = Buffer.from(value, 'base64');
  if (!buf.length) throw new Error(`${name} is not valid base64`);
  if (buf.length > MAX_BINARY_BYTES) throw new Error(`${name} is larger than ${MAX_BINARY_BYTES} bytes`);
  return new Uint8Array(buf);
}

async function buildBinaryBody(tool: CatalogTool, args: Record<string, unknown>): Promise<{ body: BodyInit; contentType?: string }> {
  const bytes = base64Bytes(args.content_base64, 'content_base64');
  if (tool.rest!.binary === 'form-file') {
    const form = new FormData();
    const name = typeof args.filename === 'string' && args.filename ? args.filename : 'backup.bin';
    form.set('file', new Blob([bytes as unknown as BlobPart], { type: 'application/octet-stream' }), name);
    if (args.replace !== undefined) form.set('replace', args.replace === true ? 'true' : String(args.replace));
    return { body: form };
  }
  const contentType = typeof args.content_type === 'string' && args.content_type ? args.content_type : 'application/octet-stream';
  return { body: bytes as unknown as BodyInit, contentType };
}

function authHeaders(ctx: ActionContext): Record<string, string> {
  const headers: Record<string, string> = {};
  const authorization = ctx.headers?.get('authorization');
  const cookie = ctx.headers?.get('cookie');
  if (authorization) headers.authorization = authorization;
  if (cookie) headers.cookie = cookie;
  if (ctx.ip) headers['x-forwarded-for'] = ctx.ip;
  return headers;
}

/** A response body that is not JSON (a zip, a sqlite file) becomes base64 text plus its content type. */
async function binaryResult(response: Response): Promise<ReturnType<typeof textResult>> {
  const buf = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get('content-type') || 'application/octet-stream';
  const disposition = response.headers.get('content-disposition') || '';
  const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? null;
  return textResult(
    `Binary response (${contentType}${filename ? `, ${filename}` : ''}), ${buf.length} bytes, base64 below.\n${buf.toString('base64').slice(0, 20_000)}${buf.length > 15_000 ? '\n… (truncated; request a smaller export)' : ''}`,
    { content_type: contentType, filename, bytes: buf.length, content_base64: buf.toString('base64') },
  );
}

export async function callRestTool(
  ctx: ActionContext,
  tool: CatalogTool,
  args: Record<string, unknown>,
  modules: Record<string, () => Promise<Record<string, unknown>>> = ROUTE_MODULES,
): Promise<ToolResult> {
  const spec = tool.rest;
  if (!spec) return errorResult(`Tool ${tool.name} has no route`);

  if (tool.requiresConfirm && args.confirm !== true) {
    return errorResult(`Confirmation required: ${tool.confirmText ?? tool.description} (send confirm: true)`);
  }

  let body: BodyInit | undefined;
  let contentType: string | undefined;
  if (spec.binary && spec.method !== 'GET' && spec.method !== 'DELETE') {
    const built = await buildBinaryBody(tool, args);
    body = built.body;
    contentType = built.contentType;
  } else {
    const json = bodyOf(tool, args);
    if (json !== null) {
      body = JSON.stringify(json);
      contentType = 'application/json';
    }
  }

  const path = `/api/${buildPath(spec.route, args, spec.path)}${buildQuery(args, spec.query)}`;
  const origin = ctx.origin ?? 'http://localhost';
  const headers = authHeaders(ctx);
  if (contentType) headers['content-type'] = contentType;
  const request = new NextRequest(`${origin}${path}`, {
    method: spec.method,
    headers,
    ...(body !== undefined && spec.method !== 'GET' ? { body } : {}),
  });

  const loader = modules[spec.route];
  if (!loader) return errorResult(`No REST route is registered for ${spec.route}`);
  const mod = await loader();
  const handler = mod[spec.method];
  if (typeof handler !== 'function') return errorResult(`The ${spec.method} handler for ${spec.route} is missing`);

  const params = thenableParams(Object.fromEntries(Object.entries(spec.path ?? {}).map(([param, arg]) => [param, String(args[arg] ?? '')])));
  const response: Response = await (handler as (req: NextRequest, ctx: { params: unknown }) => Promise<Response>)(request, { params });

  const responseType = response.headers.get('content-type') || '';
  if (!response.ok) {
    if (responseType.includes('application/json')) {
      const json = await response.json().catch(() => null);
      return errorResult(toolErrorFromBody(json, `HTTP ${response.status}`));
    }
    const text = await response.text().catch(() => '');
    return errorResult(truncate(text || `HTTP ${response.status}`, 4000));
  }

  if (!responseType.includes('application/json')) return binaryResult(response);

  const json = await response.json().catch(() => null);
  const structured = json && typeof json === 'object' && !Array.isArray(json)
    ? ('data' in json ? (json as { data?: unknown }).data : json)
    : json;
  const text = formatRestResult(structured);
  return textResult(text, structured && typeof structured === 'object' && !Array.isArray(structured)
    ? structured as Record<string, unknown>
    : { data: structured });
}

function formatRestResult(data: unknown): string {
  if (data === null || data === undefined) return 'Done.';
  if (typeof data !== 'object') return String(data);
  try {
    return truncate(JSON.stringify(data, null, 2), 8000);
  } catch {
    return truncate(String(data), 8000);
  }
}
