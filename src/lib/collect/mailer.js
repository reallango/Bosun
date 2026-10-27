'use strict';

/**
 * Outgoing email (SMTP) for Next.js and the poller.
 *
 * Builds a nodemailer transport from a plain config object, so callers decide
 * where the settings come from (the web app reads app_config and decrypts the
 * password with lib/crypto/keys; the poller with ssh.decryptSecret). No other
 * dependencies, CommonJS, copied into the runtime image with src/lib/collect.
 *
 * Config: { host, port, security: 'none' | 'starttls' | 'tls', user, password, from }
 */

const nodemailer = require('nodemailer');
const { isValidFrom } = require('./recipients');

const SECURITY = ['none', 'starttls', 'tls'];

/** @param {string} s */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Reject a config that cannot work; returns an error message or null.
 * @param {any} cfg
 */
function configError(cfg) {
  if (!cfg || typeof cfg !== 'object') return 'SMTP is not configured';
  if (!cfg.host || typeof cfg.host !== 'string') return 'SMTP host is not set';
  const port = Number(cfg.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return 'SMTP port is invalid';
  if (!SECURITY.includes(cfg.security)) return 'SMTP security must be none, starttls or tls';
  if (!isValidFrom(cfg.from)) return 'SMTP sender (From) is not a valid address';
  return null;
}

/**
 * nodemailer SMTP transport options for a config.
 * @param {any} cfg
 */
function transportOptions(cfg) {
  const security = SECURITY.includes(cfg.security) ? cfg.security : 'starttls';
  /** @type {Record<string, unknown>} */
  const opts = {
    host: cfg.host,
    port: Number(cfg.port) || (security === 'tls' ? 465 : 587),
    secure: security === 'tls',
    requireTLS: security === 'starttls',
    ignoreTLS: security === 'none',
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  };
  if (cfg.user) opts.auth = { user: cfg.user, pass: cfg.password || '' };
  return opts;
}

/**
 * Create a mailer. `transport` overrides the SMTP transport (tests pass
 * `{ jsonTransport: true }` or `{ streamTransport: true }`).
 * @param {any} cfg
 * @param {{ transport?: any }} [options]
 * @returns {{ from: string, send: (msg: { to: string | string[], subject: string, text: string, html?: string }) => Promise<any>, verify: () => Promise<boolean>, close: () => void }}
 */
function createMailer(cfg, options = {}) {
  const err = configError(cfg);
  if (err) throw new Error(err);
  const transporter = nodemailer.createTransport(options.transport || transportOptions(cfg));
  return {
    from: cfg.from,
    async send(msg) {
      const to = Array.isArray(msg.to) ? msg.to : [msg.to];
      if (!to.length) throw new Error('No recipients');
      if (/[\r\n]/.test(msg.subject)) throw new Error('Invalid subject');
      return transporter.sendMail({ from: cfg.from, to, subject: msg.subject, text: msg.text, html: msg.html });
    },
    async verify() {
      if (typeof transporter.verify !== 'function') return true;
      return transporter.verify();
    },
    close() {
      if (typeof transporter.close === 'function') transporter.close();
    },
  };
}

/**
 * Cache a mailer built from a config loader, re-reading the config at most
 * every `ttlMs` and rebuilding the transport only when it changed.
 * The loader returns null when email is disabled.
 * @param {() => Promise<any | null>} loadConfig
 * @param {{ ttlMs?: number, now?: () => number, transport?: any }} [options]
 */
function mailerCache(loadConfig, options = {}) {
  const ttlMs = options.ttlMs ?? 60000;
  const now = options.now || Date.now;
  let checkedAt = -Infinity;
  let fingerprint = null;
  /** @type {ReturnType<typeof createMailer> | null} */
  let mailer = null;
  return async function get() {
    if (now() - checkedAt < ttlMs) return mailer;
    checkedAt = now();
    let cfg = null;
    try {
      cfg = await loadConfig();
    } catch {
      // Keep the previous mailer when the database is briefly unavailable.
      return mailer;
    }
    const fp = cfg ? JSON.stringify(cfg) : null;
    if (fp === fingerprint) return mailer;
    fingerprint = fp;
    if (mailer) mailer.close();
    mailer = null;
    if (cfg) {
      try {
        mailer = createMailer(cfg, { transport: options.transport });
      } catch {
        mailer = null;
      }
    }
    return mailer;
  };
}

/** app_config keys holding the SMTP settings. */
const SMTP_KEYS = ['smtp.enabled', 'smtp.host', 'smtp.port', 'smtp.security', 'smtp.user', 'smtp.password_enc', 'smtp.from'];

/**
 * Turn app_config rows ({ key: value }) into a mailer config, decrypting the
 * password with `decrypt`. Returns null when SMTP is disabled or incomplete.
 * @param {Record<string, string | null | undefined>} values
 * @param {(enc: string) => string} decrypt
 * @param {{ ignoreEnabled?: boolean }} [options]
 */
function configFromValues(values, decrypt, options = {}) {
  if (!options.ignoreEnabled && values['smtp.enabled'] !== 'true') return null;
  if (!values['smtp.host']) return null;
  let password = '';
  if (values['smtp.password_enc']) {
    try {
      password = decrypt(String(values['smtp.password_enc']));
    } catch {
      password = '';
    }
  }
  const security = SECURITY.includes(String(values['smtp.security'])) ? String(values['smtp.security']) : 'starttls';
  return {
    host: String(values['smtp.host']),
    port: Number(values['smtp.port']) || (security === 'tls' ? 465 : 587),
    security,
    user: values['smtp.user'] ? String(values['smtp.user']) : '',
    password,
    from: values['smtp.from'] ? String(values['smtp.from']) : '',
  };
}

module.exports = { createMailer, mailerCache, transportOptions, configError, configFromValues, escapeHtml, SMTP_KEYS, SECURITY };
