import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { spawnSync } from 'child_process';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { deriveCaKey, writeNodeTls, SERVER_NAME } = require('./node-tls');

// Node-to-node TLS for rqlite's port 4002: the cluster CA key comes from AUTH_SECRET, so nodes that share the secret
// trust each other with no setup, and anything else (another cluster, a host on the LAN) is refused.
const hasOpenssl = spawnSync('openssl', ['version']).status === 0;
const verify = (ca: string, cert: string, purpose: string) =>
  spawnSync('openssl', ['verify', '-CAfile', ca, '-purpose', purpose, cert], { encoding: 'utf8' });

describe('node TLS', () => {
  let dir = '';
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bosun-nodetls-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('derives the same CA key from the same AUTH_SECRET and another one from another secret', () => {
    const pub = (k: crypto.KeyObject) => crypto.createPublicKey(k).export({ type: 'spki', format: 'der' }).toString('hex');
    expect(pub(deriveCaKey('cluster-a'))).toBe(pub(deriveCaKey('cluster-a')));
    expect(pub(deriveCaKey('cluster-a'))).not.toBe(pub(deriveCaKey('cluster-b')));
    expect(deriveCaKey('cluster-a').asymmetricKeyDetails?.namedCurve).toBe('prime256v1');
    expect(() => deriveCaKey('')).toThrow(/AUTH_SECRET/);
  });

  it.skipIf(!hasOpenssl)('nodes made separately from the same secret verify each other, as server and as client', () => {
    const a = writeNodeTls(path.join(dir, 'a'), 'cluster-a');
    const b = writeNodeTls(path.join(dir, 'b'), 'cluster-a');
    expect(a.serverName).toBe(SERVER_NAME);
    // Each node has its own key and certificate...
    expect(fs.readFileSync(a.key, 'utf8')).not.toBe(fs.readFileSync(b.key, 'utf8'));
    // ...and each one's CA copy accepts the other's certificate.
    expect(verify(a.caCert, b.cert, 'sslserver').status).toBe(0);
    expect(verify(a.caCert, b.cert, 'sslclient').status).toBe(0);
    expect(verify(b.caCert, a.cert, 'sslserver').status).toBe(0);
    if (process.platform !== 'win32') expect(fs.statSync(a.key).mode & 0o777).toBe(0o600);
  });

  it.skipIf(!hasOpenssl)('a node made from another secret is refused', () => {
    const a = writeNodeTls(path.join(dir, 'a'), 'cluster-a');
    const other = writeNodeTls(path.join(dir, 'x'), 'cluster-b');
    expect(verify(a.caCert, other.cert, 'sslclient').status).not.toBe(0);
    expect(verify(other.caCert, a.cert, 'sslserver').status).not.toBe(0);
  });

  it.skipIf(!hasOpenssl)('certificates carry the fixed name, both key usages, and are valid from 2000 (clock skew between nodes)', () => {
    const a = writeNodeTls(path.join(dir, 'a'), 'cluster-a');
    const x = new crypto.X509Certificate(fs.readFileSync(a.cert));
    const ca = new crypto.X509Certificate(fs.readFileSync(a.caCert));
    expect(x.subjectAltName).toBe(`DNS:${SERVER_NAME}`);
    expect(x.keyUsage).toEqual(expect.arrayContaining(['1.3.6.1.5.5.7.3.1', '1.3.6.1.5.5.7.3.2']));
    expect(new Date(x.validFrom).getUTCFullYear()).toBe(2000);
    expect(x.ca).toBe(false);
    expect(ca.ca).toBe(true);
    expect(x.checkIssued(ca)).toBe(true);
    // The CA key is never left next to the node files.
    expect(fs.readdirSync(path.join(dir, 'a')).sort()).toEqual(['ca.crt', 'node.crt', 'node.key']);
  });
});
