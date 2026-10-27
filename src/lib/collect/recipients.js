'use strict';

/**
 * Email address helpers shared by the browser (alerts page), the API routes
 * and the poller. Dependency-free CommonJS.
 */

// Pragmatic address check: one @, no whitespace/commas/angle brackets, a dot
// in the domain. Not RFC 5322, but rejects typos and header injection.
const EMAIL_RE = /^[^\s@<>,;"()[\]\\]+@[^\s@<>,;"()[\]\\]+\.[^\s@<>,;"()[\]\\]+$/;
const MAX_RECIPIENTS = 20;

/** @param {unknown} value */
function isValidEmail(value) {
  return typeof value === 'string' && value.length <= 254 && EMAIL_RE.test(value);
}

/**
 * Parse a comma/semicolon/whitespace separated list (or an array) of
 * addresses. Duplicates are dropped (case-insensitively).
 * @param {unknown} input
 * @returns {{ emails: string[], invalid: string[] }}
 */
function parseRecipients(input) {
  /** @type {string[]} */
  let parts = [];
  if (Array.isArray(input)) parts = input.map(v => String(v));
  else if (typeof input === 'string') parts = input.split(/[,;\s]+/);
  const emails = [];
  const invalid = [];
  const seen = new Set();
  for (const raw of parts) {
    const e = raw.trim();
    if (!e) continue;
    if (!isValidEmail(e)) { invalid.push(e); continue; }
    const key = e.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    emails.push(e);
  }
  if (emails.length > MAX_RECIPIENTS) invalid.push(`more than ${MAX_RECIPIENTS} recipients`);
  return { emails, invalid };
}

/**
 * Validate a "From" value: `addr@example.com` or `Display Name <addr@example.com>`.
 * @param {unknown} value
 */
function isValidFrom(value) {
  if (typeof value !== 'string' || /[\r\n]/.test(value)) return false;
  const v = value.trim();
  const m = /^(.*)<([^<>]+)>$/.exec(v);
  if (m) return isValidEmail(m[2].trim()) && !/[<>]/.test(m[1]);
  return isValidEmail(v);
}

module.exports = { isValidEmail, parseRecipients, isValidFrom, MAX_RECIPIENTS };
