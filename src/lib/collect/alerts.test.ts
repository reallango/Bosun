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
