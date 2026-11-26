import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from './middleware';

describe('the sign-in redirect', () => {
  it('is relative, so it never points at Next\'s internal address behind nginx', () => {
    // Behind the container's nginx, Next sees itself as localhost:3000 whatever address the browser used.
    const res = middleware(new NextRequest('http://localhost:3000/servers', { headers: { host: 'bosun.example.test' } }));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('/login');
  });

  it('lets signed-in pages, sign-in pages and the API through', () => {
    const signedIn = new NextRequest('http://localhost:3000/servers', { headers: { cookie: 'access_token=x' } });
    for (const req of [signedIn, new NextRequest('http://localhost:3000/login'), new NextRequest('http://localhost:3000/api/health')]) {
      expect(middleware(req).headers.get('location')).toBeNull();
    }
  });
});
