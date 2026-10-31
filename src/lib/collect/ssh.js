'use strict';

/**
 * Small ssh2 helpers shared by poller.js, ws-server.js and the Next.js server.
 *
 * - connect(): one client per host; callers keep it open and multiplex exec
 *   channels over it instead of reconnecting per command.
 * - Host keys are pinned trust-on-first-use: the first fingerprint seen is
 *   stored (via onNewFingerprint) and later connections with a different key
 *   are refused.
 * - exec(): output size cap and a timeout that closes the channel (the
 *   connection stays up).
 */

const crypto = require('crypto');

function loadSsh2() {
  // Required lazily so this module can be imported where ssh2 is unused (tests).
  return require('ssh2');
}

function fingerprint(keyBuffer) {
  return 'SHA256:' + crypto.createHash('sha256').update(keyBuffer).digest('base64').replace(/=+$/, '');
}

/** Same scheme as src/lib/crypto/keys.ts (AES-256-GCM, PBKDF2-derived key). */
function decryptSecret(encryptedBase64, masterKey) {
  const key = crypto.pbkdf2Sync(masterKey, 'bosun-ssh-key-encryption', 100000, 32, 'sha256');
  const combined = Buffer.from(encryptedBase64, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, combined.subarray(0, 16));
  decipher.setAuthTag(combined.subarray(16, 32));
  return decipher.update(combined.subarray(32), undefined, 'utf8') + decipher.final('utf8');
}

class HostKeyMismatchError extends Error {
  constructor(host, expected, actual) {
    super(`Host key for ${host} changed (expected ${expected}, got ${actual}). Clear the stored fingerprint in server settings if this is expected.`);
    this.name = 'HostKeyMismatchError';
    this.code = 'HOST_KEY_MISMATCH';
  }
}

/**
 * Open an SSH connection.
 * opts: { host, port, username, privateKey?, passphrase?, password?,
 *         expectedFingerprint?, onNewFingerprint?(fp), readyTimeout?, keepaliveInterval? }
 */
function connect(opts) {
  const { Client } = loadSsh2();
  return new Promise((resolve, reject) => {
    const client = new Client();
    let mismatch = null;
    let settled = false;
    const done = (err, value) => {
      if (settled) return;
      settled = true;
      if (err) reject(err); else resolve(value);
    };
    client.on('ready', () => done(null, client));
    client.on('error', err => {
      done(mismatch || err);
    });
    client.on('close', () => done(mismatch || new Error('Connection closed before ready')));
    client.connect({
      host: opts.host,
      port: opts.port || 22,
      username: opts.username,
      privateKey: opts.privateKey,
      passphrase: opts.passphrase,
      password: opts.password,
      readyTimeout: opts.readyTimeout || 10000,
      keepaliveInterval: opts.keepaliveInterval ?? 30000,
      keepaliveCountMax: 3,
      hostVerifier: (key) => {
        const fp = fingerprint(key);
        if (opts.expectedFingerprint && opts.expectedFingerprint !== fp) {
          mismatch = new HostKeyMismatchError(opts.host, opts.expectedFingerprint, fp);
          return false;
        }
        if (!opts.expectedFingerprint && typeof opts.onNewFingerprint === 'function') {
          try { opts.onNewFingerprint(fp); } catch { /* best effort */ }
        }
        return true;
      },
    });
  });
}

/**
 * Run one command on an open client.
 * Resolves { stdout, stderr, exitCode, durationMs, timedOut, truncated }.
 * Rejects only if the channel cannot be opened (connection-level failure).
 */
/**
 * @param {any} client
 * @param {string} command
 * @param {{ stdin?: string, timeoutMs?: number, maxBytes?: number, pty?: object, onData?: (text: string, isErr: boolean) => void, signal?: AbortSignal }} [opts]
 */
function exec(client, command, opts = {}) {
  const { stdin, timeoutMs = 30000, maxBytes = 4 * 1024 * 1024, pty, onData, signal } = opts;
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const cb = (err, stream) => {
      if (err) return reject(err);
      let stdout = '';
      let stderr = '';
      let bytes = 0;
      let truncated = false;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try { if (stream.signal) stream.signal('KILL'); } catch { /* not supported everywhere */ }
        try { stream.close(); } catch { /* ignore */ }
      }, timeoutMs);
      let aborted = false;
      const onAbort = () => {
        aborted = true;
        try { stream.close(); } catch { /* ignore */ }
      };
      if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); }
      const take = (chunk, toErr) => {
        if (onData) { try { onData(chunk.toString('utf8'), toErr); } catch { /* a faulty listener must not break the command */ } }
        bytes += chunk.length;
        if (bytes > maxBytes) {
          truncated = true;
          return;
        }
        if (toErr) stderr += chunk.toString('utf8'); else stdout += chunk.toString('utf8');
      };
      stream.on('data', d => take(d, false));
      stream.stderr.on('data', d => take(d, true));
      stream.on('close', (code) => {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve({ stdout, stderr, exitCode: typeof code === 'number' ? code : (timedOut ? 124 : -1), durationMs: Date.now() - start, timedOut, truncated, aborted });
      });
      if (stdin !== undefined) stream.end(stdin); else stream.end();
    };
    if (pty) client.exec(command, { pty }, cb); else client.exec(command, cb);
  });
}

/**
 * Start a long-running command and stream its stdout line by line.
 * Returns { done: Promise<{ exitCode, stderr }>, cancel() }. Cancelling closes
 * the channel; the remote process gets SIGPIPE/EOF and exits.
 */
function streamLines(client, command, onLine, { timeoutMs = 6 * 3600 * 1000 } = {}) {
  let channel = null;
  let cancelled = false;
  const done = new Promise((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) return reject(err);
      channel = stream;
      if (cancelled) { try { stream.close(); } catch { /* ignore */ } }
      let buf = '';
      let stderr = '';
      const timer = setTimeout(() => { try { stream.close(); } catch { /* ignore */ } }, timeoutMs);
      stream.on('data', d => {
        buf += d.toString('utf8');
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).replace(/\r$/, '');
          buf = buf.slice(i + 1);
          if (line) { try { onLine(line); } catch { /* consumer errors must not kill the stream */ } }
        }
      });
      stream.stderr.on('data', d => { if (stderr.length < 8192) stderr += d.toString('utf8'); });
      stream.on('close', code => {
        clearTimeout(timer);
        if (buf.trim()) { try { onLine(buf.trim()); } catch { /* ignore */ } }
        resolve({ exitCode: typeof code === 'number' ? code : -1, stderr, cancelled });
      });
      stream.end();
    });
  });
  return {
    done,
    cancel() {
      cancelled = true;
      if (channel) { try { channel.close(); } catch { /* ignore */ } }
    },
  };
}

/** Quote a string for a POSIX shell. */
function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

module.exports = { connect, exec, streamLines, fingerprint, decryptSecret, shQuote, HostKeyMismatchError };
