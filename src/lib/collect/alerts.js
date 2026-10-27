'use strict';

/**
 * Threshold alerts, evaluated by the poller right after each poll of a host
 * against the metrics it just collected (no extra queries or SSH).
 *
 * A rule fires when `metric <condition> threshold` holds for a host the rule
 * applies to (rule.server_id null = every host) and its cooldown has passed.
 * Firing creates an in-app notification and bumps last_triggered/trigger_count;
 * webhook-type channels get a JSON POST.
 */

const crypto = require('crypto');

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

/** DB statements recording fired alerts. */
function alertStatements(fired, server, nowMs) {
  const iso = new Date(nowMs).toISOString();
  const stmts = [];
  for (const f of fired) {
    stmts.push({
      sql: 'INSERT INTO notifications (id, alert_rule_id, server_id, severity, title, message, delivered_via) VALUES (?, ?, ?, ?, ?, ?, ?)',
      params: [crypto.randomUUID(), f.rule.id, server.id, f.rule.severity || 'warning', f.title, f.message, '["in_app"]'],
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

module.exports = { evaluateRules, alertStatements, deliverWebhooks, CONDITIONS };
