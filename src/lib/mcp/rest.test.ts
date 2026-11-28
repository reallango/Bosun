/**
 * The generic REST adapter: it must build the same request a REST client would (path, query, body), forward only the
 * caller's Authorization/Cookie, and turn the route's answer (JSON or binary) back into a tool result.
 */
import { describe, expect, it } from 'vitest';
import { callRestTool } from './rest';
import type { CatalogTool } from './types';

interface Call { url: string; auth: string | null; cookie: string | null; forwardedFor: string | null; id: string; body?: unknown; file?: { name: string; text: string }; replace?: string | null }

function harness() {
  const calls: Call[] = [];
  const modules: Record<string, () => Promise<Record<string, unknown>>> = {
    'fake/[id]': async () => ({
      POST: async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
        const { id } = await params;
        const call: Call = {
          url: request.url, auth: request.headers.get('authorization'), cookie: request.headers.get('cookie'),
          forwardedFor: request.headers.get('x-forwarded-for'), id,
        };
        if ((request.headers.get('content-type') || '').includes('multipart/form-data')) {
          const form = await request.formData();
          const file = form.get('file') as File | null;
          call.file = file ? { name: file.name, text: await file.text() } : undefined;
          call.replace = form.get('replace') as string | null;
        } else {
          call.body = await request.json().catch(() => undefined);
        }
        calls.push(call);
        return Response.json({ data: { ok: true, id } });
      },
    }),
    'fake/binary': async () => ({
      GET: async () => new Response(Buffer.from('zipdata'), {
        headers: { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="export.zip"' },
      }),
    }),
    'fake/fail': async () => ({
      POST: async () => Response.json({ error: { message: 'Not permitted', permission: 'shell.user', request: { endpoint: 'POST /api/access-requests', body: { kind: 'command' } } } }, { status: 403 }),
    }),
  };
  const ctx = {
    auth: { userId: 'u1', username: 'u', role: 'operator', authType: 'api_key', apiKeyId: 'k1' } as never,
    ip: '10.0.0.9',
    headers: new Headers({ authorization: 'Bearer bosun_test', cookie: 'session=abc' }),
    origin: 'https://bosun.test',
  };
  return { calls, modules, ctx };
}

function tool(over: Partial<CatalogTool>): CatalogTool {
  return {
    kind: 'rest', name: 'fake_tool', description: 'A fake route.', title: 'Fake',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    ...over,
  } as CatalogTool;
}

const textOf = (r: { content: Array<{ type: string; text?: string }> }) => r.content.filter(c => c.type === 'text').map(c => c.text).join('\n');

describe('REST adapter', () => {
  it('fills path and query, strips path/query/confirm from the body, and forwards only Authorization/Cookie', async () => {
    const { calls, modules, ctx } = harness();
    const t = tool({
      requiresConfirm: true, confirmText: 'This runs a command.',
      rest: {
        route: 'fake/[id]', method: 'POST', path: { id: 'thing_id' },
        query: [{ arg: 'q', trueValue: '1' }, { arg: 'dry', trueValue: 'true' }],
        body: 'rest',
      },
      routes: ['POST fake/[id]'],
    });
    const result = await callRestTool(ctx, t, { thing_id: 'a b/c', q: true, dry: false, other: 'y', confirm: true }, modules);
    expect(result.isError).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      auth: 'Bearer bosun_test', cookie: 'session=abc', forwardedFor: '10.0.0.9', id: 'a b/c',
      body: { other: 'y' },
    });
    expect(calls[0].url).toBe('https://bosun.test/api/fake/a%20b%2Fc?q=1&dry=false');
    expect(result.structuredContent).toMatchObject({ ok: true });
  });

  it('refuses a destructive tool without confirm: true, and never calls the route', async () => {
    const { calls, modules, ctx } = harness();
    const t = tool({
      requiresConfirm: true, confirmText: 'This runs a command.',
      rest: { route: 'fake/[id]', method: 'POST', path: { id: 'thing_id' } },
    });
    const result = await callRestTool(ctx, t, { thing_id: 'srv-1' }, modules);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('This runs a command.');
    expect(calls).toHaveLength(0);
  });

  it('sends a bodyRoot argument as the whole JSON body', async () => {
    const { calls, modules, ctx } = harness();
    const t = tool({ rest: { route: 'fake/[id]', method: 'POST', path: { id: 'id' }, bodyRoot: 'settings' } });
    await callRestTool(ctx, t, { id: 'x', settings: { app_name: 'Bosun', port: 3000 } }, modules);
    expect(calls[0].body).toEqual({ app_name: 'Bosun', port: 3000 });
  });

  it('uploads base64 content as a multipart file for a form-file route', async () => {
    const { calls, modules, ctx } = harness();
    const t = tool({
      requiresConfirm: true, confirmText: 'Restore a backup.',
      rest: { route: 'fake/[id]', method: 'POST', path: { id: 'id' }, binary: 'form-file' },
    });
    const result = await callRestTool(ctx, t, {
      id: 'db', content_base64: Buffer.from('hi').toString('base64'), filename: 'backup.sql', replace: true, confirm: true,
    }, modules);
    expect(result.isError).toBeUndefined();
    expect(calls[0].file).toEqual({ name: 'backup.sql', text: 'hi' });
    expect(calls[0].replace).toBe('true');
  });

  it('returns a binary response as base64 with its content type and file name', async () => {
    const { modules, ctx } = harness();
    const t = tool({ rest: { route: 'fake/binary', method: 'GET', binary: 'raw' } });
    const result = await callRestTool(ctx, t, {}, modules);
    expect(result.structuredContent).toMatchObject({
      content_type: 'application/zip', filename: 'export.zip', bytes: 7, content_base64: Buffer.from('zipdata').toString('base64'),
    });
  });

  it('keeps the REST 403 access-request hint in the tool error', async () => {
    const { modules, ctx } = harness();
    const t = tool({ rest: { route: 'fake/fail', method: 'POST' } });
    const result = await callRestTool(ctx, t, {}, modules);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Not permitted');
    expect(textOf(result)).toContain('To request access, POST /api/access-requests with:');
  });
});
