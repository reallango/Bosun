import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as secrets from '@/lib/secrets';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { writeRqliteAuth } = require('./boot');

// rqlite's HTTP API is authenticated with credentials derived from AUTH_SECRET, so every node of a cluster (they share the
// secret through join codes) and every local process (web app, poller, ws-server) agree on them without extra setup.
describe('rqlite credentials', () => {
  let saved: string | undefined;
  let dir = '';
  beforeEach(() => { saved = process.env.AUTH_SECRET; dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bosun-rqauth-')); });
  afterEach(() => {
    if (saved === undefined) delete process.env.AUTH_SECRET; else process.env.AUTH_SECRET = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('are derived from AUTH_SECRET: the same secret gives the same password, another secret another one', () => {
    process.env.AUTH_SECRET = 'cluster-secret-a';
    const a1 = secrets.rqliteCredentials();
    const a2 = secrets.rqliteCredentials();
    process.env.AUTH_SECRET = 'cluster-secret-b';
    const b = secrets.rqliteCredentials();
    expect(a1).toEqual(a2);
    expect(a1?.username).toBe('bosun');
    expect(a1?.password).toMatch(/^[0-9a-f]{64}$/);
    expect(a1?.password).not.toContain('cluster-secret-a');
    expect(b?.password).not.toBe(a1?.password);
  });

  it('go in a Basic Authorization header', () => {
    process.env.AUTH_SECRET = 'cluster-secret-a';
    const c = secrets.rqliteCredentials()!;
    const h = secrets.rqliteAuthHeaders() as Record<string, string>;
    expect(h.Authorization).toBe(`Basic ${Buffer.from(`${c.username}:${c.password}`).toString('base64')}`);
  });

  it('the auth file gives Bosun everything and anonymous callers only /readyz', () => {
    process.env.AUTH_SECRET = 'cluster-secret-a';
    const file = writeRqliteAuth(path.join(dir, 'run', 'rqlite-auth.json'));
    const conf = JSON.parse(fs.readFileSync(file, 'utf8'));
    const c = secrets.rqliteCredentials()!;
    expect(conf).toEqual([
      { username: 'bosun', password: c.password, perms: ['all'] },
      { username: '*', perms: ['ready'] },
    ]);
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
});
