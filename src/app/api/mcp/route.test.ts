import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const requireAuth = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/middleware', () => ({ requireAuth, clientIp: () => '127.0.0.1' }));

import { DELETE, GET, POST } from './route';

const req = (path = '/api/mcp', init?: ConstructorParameters<typeof NextRequest>[1]) =>
  new NextRequest(`https://bosun.example.com${path}`, init);

const refusal = (status: number, message: string, code: string, headers?: HeadersInit) =>
  NextResponse.json({ data: null, error: { message, code } }, { status, headers });

beforeEach(() => {
  requireAuth.mockReset();
});

describe('POST /api/mcp refusals', () => {
  it.each([
    [401, 'Invalid API key', 'INVALID_API_KEY'],
    [401, 'API key has expired', 'API_KEY_EXPIRED'],
    [401, 'API key has been revoked', 'API_KEY_REVOKED'],
    [401, 'Not authenticated', 'NOT_AUTHENTICATED'],
    [403, 'Insufficient permissions: requires "Admin" access', 'FORBIDDEN'],
  ])('answers %i %s as a JSON-RPC error', async (status, message, code) => {
    requireAuth.mockResolvedValue(refusal(status, message, code) as never);
    const response = await POST(req('/api/mcp', { method: 'POST' }));

    expect(response.status).toBe(status);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32001, message, data: { code } },
    });
  });

  it('never points at an OAuth resource-metadata document', async () => {
    requireAuth.mockResolvedValue(
      refusal(401, 'Not authenticated', 'NOT_AUTHENTICATED', {
        'WWW-Authenticate': 'Bearer resource_metadata="https://bosun.example.com/.well-known/oauth-protected-resource"',
      }) as never,
    );
    const challenge = (await POST(req('/api/mcp', { method: 'POST' }))).headers.get('www-authenticate');
    expect(challenge).toBe('Bearer realm="bosun"');
    expect(challenge).not.toContain('resource_metadata');
  });

  it('keeps a rate-limit Retry-After on the JSON refusal', async () => {
    requireAuth.mockResolvedValue(
      refusal(429, 'Too many requests for this API key', 'RATE_LIMITED', { 'Retry-After': '12' }) as never,
    );
    const response = await POST(req('/api/mcp', { method: 'POST' }));
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('12');
    expect((await response.json()).error.data.code).toBe('RATE_LIMITED');
  });
});

describe('GET and DELETE /api/mcp are JSON too', () => {
  it('describes the endpoint for a plain GET', async () => {
    const response = await GET(req());
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect((await response.json()).endpoint).toBe('https://bosun.example.com/api/mcp');
  });

  it('answers a streamable-HTTP GET with a JSON 405', async () => {
    const response = await GET(req('/api/mcp', { headers: { accept: 'application/json, text/event-stream' } }));
    expect(response.status).toBe(405);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect((await response.json()).error.message).toContain('POST JSON-RPC messages to /api/mcp');
  });

  it('answers DELETE with a JSON 405', async () => {
    const response = await DELETE();
    expect(response.status).toBe(405);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect((await response.json()).error.message).toContain('stateless');
  });
});
