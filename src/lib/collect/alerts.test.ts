import { describe, it, expect } from 'vitest';
import * as alerts from './alerts';

const rule = (over: Record<string, unknown> = {}) => ({
  id: 'r1', name: 'Hot CPU', metric: 'cpu.usage', condition: 'gt', threshold: 90,
  cooldown_sec: 300, enabled: 1, server_id: null, severity: 'critical', last_triggered: null, ...over,
});
const srv = { id: 's1', name: 'ai-nuc' };

describe('alert evaluation', () => {
  it('fires when the condition holds and respects the per-host cooldown', () => {
    const last = new Map<string, number>();
    const t = 1_000_000;
    expect(alerts.evaluateRules([rule()], srv, { 'cpu.usage': 95 }, t, last)).toHaveLength(1);
    expect(alerts.evaluateRules([rule()], srv, { 'cpu.usage': 97 }, t + 60_000, last)).toHaveLength(0);
    expect(alerts.evaluateRules([rule()], srv, { 'cpu.usage': 97 }, t + 301_000, last)).toHaveLength(1);
    // A fleet-wide rule alerts independently for another host.
    expect(alerts.evaluateRules([rule()], { id: 's2', name: 'b' }, { 'cpu.usage': 99 }, t + 1000, last)).toHaveLength(1);
  });

  it('ignores disabled rules, other servers, missing metrics and false conditions', () => {
    const last = new Map<string, number>();
    const m = { 'cpu.usage': 95 };
    expect(alerts.evaluateRules([rule({ enabled: 0 })], srv, m, 0, last)).toHaveLength(0);
    expect(alerts.evaluateRules([rule({ server_id: 'other' })], srv, m, 0, last)).toHaveLength(0);
    expect(alerts.evaluateRules([rule({ metric: 'gpu0.util' })], srv, m, 0, last)).toHaveLength(0);
    expect(alerts.evaluateRules([rule({ condition: 'lt' })], srv, m, 0, last)).toHaveLength(0);
  });

  it('honours last_triggered from the database after a poller restart', () => {
    const now = Date.parse('2026-10-27T10:00:00Z');
    const r = rule({ last_triggered: '2026-10-27T09:58:00Z' });
    expect(alerts.evaluateRules([r], srv, { 'cpu.usage': 95 }, now, new Map())).toHaveLength(0);
  });

  it('records a notification and bumps the rule', () => {
    const fired = alerts.evaluateRules([rule()], srv, { 'cpu.usage': 95.44 }, 0, new Map());
    expect(fired[0].message).toBe('cpu.usage is 95.4 (> 90)');
    const st = alerts.alertStatements(fired, srv, 0);
    expect(st[0].sql).toMatch(/^INSERT INTO notifications/);
    expect(st[0].params.slice(1, 4)).toEqual(['r1', 's1', 'critical']);
    expect(st[1].sql).toMatch(/trigger_count = trigger_count \+ 1/);
  });
});

describe('alert emails', () => {
  const fire = (over: Record<string, unknown> = {}) =>
    alerts.evaluateRules([rule(over)], srv, { 'cpu.usage': 95.44 }, 0, new Map());

  it('reads recipients from channel_config', () => {
    expect(alerts.alertRecipients({ channel_config: '{"emails":["a@x.io","bad","b@y.org"]}' })).toEqual(['a@x.io', 'b@y.org']);
    expect(alerts.alertRecipients({ channel_config: { emails: 'a@x.io, c@z.net' } })).toEqual(['a@x.io', 'c@z.net']);
    expect(alerts.alertRecipients({ channel_config: '{}' })).toEqual([]);
    expect(alerts.alertRecipients({ channel_config: 'not json' })).toEqual([]);
    expect(alerts.alertRecipients({})).toEqual([]);
  });

  it('builds subject, text and escaped HTML', () => {
    const [f] = fire({ name: 'Hot <CPU>' });
    const m = alerts.buildAlertEmail(f, srv, { appUrl: 'https://bosun.example.com/', nowMs: Date.parse('2026-10-27T10:00:00Z') });
    expect(m.subject).toBe('[Bosun] Critical: Hot <CPU> on ai-nuc');
    expect(m.text).toContain('Condition: cpu.usage is 95.4 (> 90)');
    expect(m.text).toContain('Time: 2026-10-27 10:00:00 UTC');
    expect(m.text).toContain('Open in Bosun: https://bosun.example.com/servers/s1');
    expect(m.html).toContain('Hot &lt;CPU&gt;');
    expect(m.html).not.toContain('<CPU>');
    expect(alerts.buildAlertEmail(f, srv, {}).text).not.toContain('Open in Bosun');
    // Newlines can never reach the subject header.
    expect(alerts.buildAlertEmail(fire({ name: 'a\r\nBcc: x@y.z' })[0], srv).subject).not.toMatch(/[\r\n]/);
  });

  it('sends one email per fired rule with recipients and marks delivery', async () => {
    const sent: { to: string[]; subject: string }[] = [];
    const mailer = { send: async (m: { to: string[]; subject: string }) => { sent.push(m); } };
    const withMail = fire({ channel_config: '{"emails":["ops@x.io"]}' });
    const without = fire({ id: 'r2' });
    expect(await alerts.deliverEmails([...withMail, ...without], srv, mailer)).toBe(1);
    expect(sent[0].to).toEqual(['ops@x.io']);
    expect(await alerts.deliverEmails(withMail, srv, null)).toBe(0);
    const failing = { send: async () => { throw new Error('smtp down'); } };
    expect(await alerts.deliverEmails(withMail, srv, failing)).toBe(0);
    expect(alerts.alertStatements(withMail, srv, 0, { email: true })[0].params[6]).toBe('["in_app","email"]');
    expect(alerts.alertStatements(without, srv, 0, { email: true })[0].params[6]).toBe('["in_app"]');
    expect(alerts.alertStatements(withMail, srv, 0)[0].params[6]).toBe('["in_app"]');
  });
});
