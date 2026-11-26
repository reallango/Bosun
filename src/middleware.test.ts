import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { loginUrl, middleware } from './middleware';

// Behind the container's nginx, Next sees itself as localhost:3000 whatever address the browser used.
const internal = (path: string, headers: Record<string, string> = {}) => new NextRequest(`http://localhost:3000${path}`, { headers });

describe('the sign-in redirect', () => {
  it('goes to the address the browser used, not Next\'s internal one', () => {
    const res = middleware(internal('/servers', { host: '192.168.1.160:3042' }));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('http://192.168.1.160:3042/login');
  });

  it('keeps https behind a tunnel or TLS proxy', () => {
    expect(String(loginUrl(internal('/', { host: 'bosun.example.test', 'x-forwarded-proto': 'https' })))).toBe('https://bosun.example.test/login');
    expect(String(loginUrl(internal('/', { host: '[fd00::5]:3042', 'x-forwarded-proto': 'http, https' })))).toBe('http://[fd00::5]:3042/login');
  });

  it('falls back to the request address for an odd Host', () => {
    for (const host of ['evil.test/path', 'a b', 'x@y']) expect(String(loginUrl(internal('/', { host })))).toBe('http://localhost:3000/login');
  });

  it('lets signed-in pages, sign-in pages and the API through', () => {
    for (const req of [internal('/servers', { cookie: 'access_token=x' }), internal('/login'), internal('/api/health')]) {
      expect(middleware(req).headers.get('location')).toBeNull();
    }
  });
});
