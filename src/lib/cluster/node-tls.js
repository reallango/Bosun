'use strict';

/**
 * Mutual TLS between rqlite nodes (Raft and the cluster service on port 4002).
 *
 * Without it that port carries every database change and every forwarded
 * request (with its credentials) in clear text, and accepts any peer.
 *
 * Nothing to configure: the cluster CA key is derived from AUTH_SECRET, which
 * every node shares (join codes carry it), exactly like the rqlite password
 * (see src/lib/secrets.js). On every start each node (re)creates, in tmpfs:
 *   ca.crt    the cluster CA (self-signed with the derived key; same subject
 *             and key on every node, so any node's copy verifies the others)
 *   node.key  a fresh key for this start
 *   node.crt  this node's certificate, signed by the CA, for both server and
 *             client use, with the fixed name `bosun-cluster` (node hostnames
 *             differ, so rqlite verifies this name instead)
 * The CA key itself is only written to a temporary directory while signing.
 *
 * Certificates are valid from 2000 to 2099 so that clock differences between
 * nodes cannot make a freshly made certificate "not yet valid" for a peer.
 *
 * Uses the openssl command (installed in the image). Dependency-free CommonJS.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const SERVER_NAME = 'bosun-cluster';
const CA_CN = 'Bosun cluster CA';
const START = '20000101000000Z';
const END = '20991231235959Z';

/** The cluster CA private key (P-256), derived from AUTH_SECRET. Same secret, same key. */
function deriveCaKey(authSecret) {
  if (!authSecret) throw new Error('no AUTH_SECRET');
  const b64u = b => Buffer.from(b).toString('base64url');
  // A P-256 scalar must be in [1, n-1]; an HMAC output is outside that range with negligible
  // probability, but try the next counter value rather than fail.
  for (let i = 0; i < 16; i++) {
    const d = crypto.createHmac('sha256', authSecret).update(`bosun-rqlite-node-ca-v1:${i}`).digest();
    try {
      const ecdh = crypto.createECDH('prime256v1');
      ecdh.setPrivateKey(d);
      const pub = ecdh.getPublicKey(null, 'uncompressed');
      return crypto.createPrivateKey({
        key: { kty: 'EC', crv: 'P-256', d: b64u(d), x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) },
        format: 'jwk',
      });
    } catch {
      /* out of range: next counter */
    }
  }
  throw new Error('could not derive the cluster CA key');
}

const CONFIG = dir => `
[ca]
default_ca = bosun_ca

[bosun_ca]
dir = ${dir.replace(/\\/g, '/')}
database = $dir/index.txt
new_certs_dir = $dir
serial = $dir/serial
default_md = sha256
policy = bosun_policy
email_in_dn = no
unique_subject = no
copy_extensions = none

[bosun_policy]
commonName = supplied

[v3_ca]
basicConstraints = critical,CA:TRUE,pathlen:0
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash

[v3_node]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = serverAuth,clientAuth
subjectAltName = DNS:${SERVER_NAME}
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
`;

/**
 * Create ca.crt, node.crt and node.key in `outDir` (mode 0700; the key 0600).
 * Returns the file paths and the name peers must present.
 */
function writeNodeTls(outDir, authSecret, { openssl = process.env.BOSUN_OPENSSL || 'openssl' } = {}) {
  const caKey = deriveCaKey(authSecret);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bosun-tls-'));
  const run = args => execFileSync(openssl, args, { cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'] });
  const f = name => path.join(tmp, name);
  try {
    fs.writeFileSync(f('ca.key'), caKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    fs.writeFileSync(f('openssl.cnf'), CONFIG(tmp));
    fs.writeFileSync(f('index.txt'), '');
    fs.writeFileSync(f('serial'), crypto.randomBytes(16).toString('hex').replace(/^./, '1') + '\n');

    // The CA: self-signed with the derived key.
    run(['req', '-new', '-key', f('ca.key'), '-subj', `/CN=${CA_CN}`, '-out', f('ca.csr')]);
    run(['ca', '-batch', '-notext', '-config', f('openssl.cnf'), '-selfsign', '-keyfile', f('ca.key'),
      '-in', f('ca.csr'), '-out', f('ca.crt'), '-extensions', 'v3_ca', '-startdate', START, '-enddate', END]);

    // This node: a fresh key, signed by the CA.
    run(['genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', f('node.key')]);
    run(['req', '-new', '-key', f('node.key'), '-subj', `/CN=${SERVER_NAME}`, '-out', f('node.csr')]);
    run(['ca', '-batch', '-notext', '-config', f('openssl.cnf'), '-cert', f('ca.crt'), '-keyfile', f('ca.key'),
      '-in', f('node.csr'), '-out', f('node.crt'), '-extensions', 'v3_node', '-startdate', START, '-enddate', END]);

    fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
    const out = {
      caCert: path.join(outDir, 'ca.crt'),
      cert: path.join(outDir, 'node.crt'),
      key: path.join(outDir, 'node.key'),
      serverName: SERVER_NAME,
    };
    const place = (src, dst, mode) => {
      const t = `${dst}.${process.pid}.tmp`;
      fs.writeFileSync(t, fs.readFileSync(f(src)), { mode });
      fs.renameSync(t, dst);
    };
    place('ca.crt', out.caCert, 0o644);
    place('node.crt', out.cert, 0o644);
    place('node.key', out.key, 0o600);
    return out;
  } catch (err) {
    const stderr = err && err.stderr ? String(err.stderr).trim().split('\n').pop() : '';
    throw new Error(`openssl failed${stderr ? `: ${stderr}` : `: ${err.message}`}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { deriveCaKey, writeNodeTls, SERVER_NAME };
