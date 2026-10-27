'use strict';

/**
 * Threshold alerts, evaluated by the poller right after each poll of a host
 * against the metrics it just collected (no extra queries or SSH).
 *
 * A rule fires when `metric <condition> threshold` holds for a host the rule
 * applies to (rule.server_id null = every host) and its cooldown has passed.
 * Firing creates an in-app notification and bumps last_triggered/trigger_count;
 * webhook-type channels get a JSON POST; addresses in channel_config.emails get
 * an email when SMTP is enabled.
 */

const crypto = require('crypto');
const { parseRecipients } = require('./recipients');
const { escapeHtml } = require('./mailer');

const CONDITIONS = {
  gt: (v, t) => v > t,
  gte: (v, t) => v >= t,
  lt: (v, t) => v < t,
  lte: (v, t) => v <= t,
};
const SYMBOL = { gt: '>', gte: '≥', lt: '<', lte: '≤' };

/**
 * @param {Array<object>} rules  rows from alert_rules
 * @param {{id: string, name: string}} server
 * @param {Record<string, number>} metrics
 * @param {number} nowMs
 * @param {Map<string, number>} lastFired  rule id + server id -> ms (mutated)
 * @returns {Array<{rule: object, value: number, title: string, message: string}>}
 */
function evaluateRules(rules, server, metrics, nowMs, lastFired) {
  const fired = [];
  for (const rule of rules) {
    if (Number(rule.enabled) !== 1) continue;
    if (rule.server_id && rule.server_id !== server.id) continue;
    const test = CONDITIONS[rule.condition];
    const value = metrics[rule.metric];
    if (!test || typeof value !== 'number' || !Number.isFinite(value)) continue;
    const threshold = Number(rule.threshold);
    if (!test(value, threshold)) continue;
    // Cooldown is per rule and host, so a fleet-wide rule alerts for each host.
    const key = `${rule.id}|${server.id}`;
    const last = lastFired.get(key) ?? (rule.last_triggered ? Date.parse(rule.last_triggered) : -Infinity);
    if (nowMs - last < Number(rule.cooldown_sec || 300) * 1000) continue;
    lastFired.set(key, nowMs);
    const shown = Math.round(value * 10) / 10;
    fired.push({
      rule,
      value,
      title: `${rule.name} on ${server.name}`,
      message: `${rule.metric} is ${shown} (${SYMBOL[rule.condition]} ${threshold})`,
    });
  }
  return fired;
}

/**
 * Email recipients configured on a rule: alert_rules.channel_config
 * `{"emails": ["ops@example.com", ...]}` (invalid entries are skipped).
 * @param {{ channel_config?: unknown }} rule
 * @returns {string[]}
 */
function alertRecipients(rule) {
  let cfg = rule && rule.channel_config;
  if (typeof cfg === 'string') {
    try { cfg = JSON.parse(cfg || '{}'); } catch { cfg = {}; }
  }
  if (!cfg || typeof cfg !== 'object') return [];
  return parseRecipients(cfg.emails).emails;
}

/**
 * Subject, plain-text and HTML body for a fired alert.
 * @param {{ rule: any, value: number, title: string, message: string }} f
 * @param {{ id: string, name: string }} server
 * @param {{ appUrl?: string, nowMs?: number }} [opts]
 */
function buildAlertEmail(f, server, opts = {}) {
  const severity = String(f.rule.severity || 'warning');
  const sev = severity.charAt(0).toUpperCase() + severity.slice(1);
  const oneLine = s => String(s).replace(/[\r\n]+/g, ' ').trim();
  const subject = oneLine(`[Bosun] ${sev}: ${f.rule.name} on ${server.name}`).slice(0, 250);
  const when = new Date(opts.nowMs ?? Date.now()).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
  const base = (opts.appUrl || '').replace(/\/+$/, '');
  const link = /^https?:\/\//.test(base) ? `${base}/servers/${encodeURIComponent(server.id)}` : '';
  const rows = [
    ['Rule', f.rule.name],
    ['Server', server.name],
    ['Severity', severity],
    ['Condition', f.message],
    ['Time', when],
  ];
  if (f.rule.description) rows.push(['Description', f.rule.description]);
  const text = [
    `${sev} alert: ${f.rule.name} on ${server.name}`,
    '',
    ...rows.map(([k, v]) => `${k}: ${v}`),
    ...(link ? ['', `Open in Bosun: ${link}`] : []),
    '',
    '--',
    `You receive this because your address is listed on the alert rule "${f.rule.name}".`,
  ].join('\n');
  const color = severity === 'critical' ? '#dc2626' : severity === 'info' ? '#2563eb' : '#d97706';
  const html = `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#111;line-height:1.5;max-width:560px;margin:0 auto;padding:16px">
<h2 style="margin:0 0 12px"><span style="color:${color}">${escapeHtml(sev)}</span>: ${escapeHtml(f.rule.name)} on ${escapeHtml(server.name)}</h2>
<table style="border-collapse:collapse">${rows.map(([k, v]) => `<tr><td style="padding:2px 12px 2px 0;color:#555">${escapeHtml(k)}</td><td style="padding:2px 0">${escapeHtml(v)}</td></tr>`).join('')}</table>
${link ? `<p><a href="${escapeHtml(link)}">Open ${escapeHtml(server.name)} in Bosun</a></p>` : ''}
<hr style="border:none;border-top:1px solid #ddd"><p style="font-size:12px;color:#666">You receive this because your address is listed on the alert rule &quot;${escapeHtml(f.rule.name)}&quot;.</p>
</body></html>`;
  return { subject, text, html };
}

/**
 * Email fired alerts to the recipients on each rule. `mailer` comes from
 * mailer.js (null = email disabled). Failures are logged, never thrown.
 * @returns {Promise<number>} emails sent
 */
async function deliverEmails(fired, server, mailer, opts = {}) {
  if (!mailer) return 0;
  let sent = 0;
  for (const f of fired) {
    const to = alertRecipients(f.rule);
    if (!to.length) continue;
    try {
      await mailer.send({ to, ...buildAlertEmail(f, server, opts) });
      sent++;
    } catch (err) {
      console.warn('[Poller] alert email failed:', err && err.message);
    }
  }
  return sent;
}

/**
 * DB statements recording fired alerts. With `opts.email` (SMTP enabled),
 * notifications for rules with recipients are marked as also emailed.
 */
function alertStatements(fired, server, nowMs, opts = {}) {
  const iso = new Date(nowMs).toISOString();
  const stmts = [];
  for (const f of fired) {
    const via = opts.email && alertRecipients(f.rule).length ? '["in_app","email"]' : '["in_app"]';
    stmts.push({
      sql: 'INSERT INTO notifications (id, alert_rule_id, server_id, severity, title, message, delivered_via) VALUES (?, ?, ?, ?, ?, ?, ?)',
      params: [crypto.randomUUID(), f.rule.id, server.id, f.rule.severity || 'warning', f.title, f.message, via],
    });
    stmts.push({
      sql: 'UPDATE alert_rules SET last_triggered = ?, trigger_count = trigger_count + 1 WHERE id = ?',
      params: [iso, f.rule.id],
    });
  }
  return stmts;
}

/** POST fired alerts to webhook/discord/slack channels listed on the rule. */
async function deliverWebhooks(fired, channelsById) {
  for (const f of fired) {
    let ids = [];
    try { ids = JSON.parse(f.rule.channels || '[]'); } catch { ids = []; }
    for (const id of ids) {
      const ch = channelsById.get(id);
      if (!ch || Number(ch.enabled) !== 1) continue;
      let cfg = {};
      try { cfg = JSON.parse(ch.config || '{}'); } catch { cfg = {}; }
      if (!cfg.url || !/^https?:\/\//.test(cfg.url)) continue;
      const text = `${f.title}: ${f.message}`;
      const body = ch.type === 'discord' ? { content: text }
        : ch.type === 'slack' ? { text }
        : { alert: f.rule.name, severity: f.rule.severity, message: f.message, title: f.title };
      try {
        await fetch(cfg.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
      } catch (err) {
        console.warn('[Poller] alert webhook failed:', err.message);
      }
    }
  }
}

module.exports = { evaluateRules, alertStatements, deliverWebhooks, deliverEmails, buildAlertEmail, alertRecipients, CONDITIONS };
