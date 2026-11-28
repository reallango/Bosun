import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { GET as protectedResource } from '@/app/.well-known/oauth-protected-resource/[[...path]]/route';
import { GET as authorizationServer } from '@/app/.well-known/oauth-authorization-server/[[...path]]/route';
import { GET as openidConfiguration } from '@/app/.well-known/openid-configuration/[[...path]]/route';
import { OAUTH_NOT_SUPPORTED_DESCRIPTION } from './discovery';

// No Authorization header, no cookie: these probes arrive without any credentials.
const probe = (path: string) => new NextRequest(`https://bosun.example.com${path}`);

const routes: Array<[string, (request: NextRequest) => Response]> = [
  ['/.well-known/oauth-protected-resource', protectedResource],
  ['/.well-known/oauth-protected-resource/api/mcp', protectedResource],
  ['/.well-known/oauth-authorization-server', authorizationServer],
  ['/.well-known/oauth-authorization-server/api/mcp', authorizationServer],
  ['/.well-known/openid-configuration', openidConfiguration],
];

describe('MCP/OAuth discovery probes', () => {
  it.each(routes)('answers %s with a JSON "not supported" 404', async (path, handler) => {
    const response = await handler(probe(path));
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      error: 'not_supported',
      error_description: OAUTH_NOT_SUPPORTED_DESCRIPTION,
    });
  });

  it('tells the client the endpoint uses a static API key', () => {
    expect(OAUTH_NOT_SUPPORTED_DESCRIPTION).toContain('static API key');
    expect(OAUTH_NOT_SUPPORTED_DESCRIPTION).toContain('OAuth is not offered');
  });
});
