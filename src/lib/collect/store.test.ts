import { describe, it, expect } from 'vitest';
import { retentionStatements, metricStatements, likeFor, mergeDefinitions } from './store';

const cfg = { rawHours: 48, rollup5mDays: 30, rollup1hDays: 400 };
const NOW = 1_700_000_000_000;

describe('metric statements', () => {
  it('writes a raw sample and both rollups per number and skips non-numbers', () => {
    const s = metricStatements('srv', { 'a.b': 1.5, 'c.d': NaN, 'e.f': 'x' as unknown as number }, NOW);
    expect(s).toHaveLength(3);
    expect(s[0].params).toEqual(['srv', 'a.b', 1_700_000_000, 1.5]);
  });
});

describe('retention', () => {
  it('uses the global settings when no widget names a metric', () => {
    const s = retentionStatements(cfg, NOW, []);
    expect(s).toHaveLength(3);
    expect(s[0].sql).not.toMatch(/LIKE/);
  });

  it('keeps the metrics a widget names for its own time and leaves them out of the global cleanup', () => {
    const defs = [{ pattern: 'cpu.usage', raw_hours: 2000, rollup_5m_days: null, rollup_1h_days: 900 }];
    const s = retentionStatements(cfg, NOW, defs);
    expect(s).toHaveLength(6);
    expect(s[0].sql).toMatch(/NOT \(metric LIKE \?/);
    expect(s[0].params[1]).toBe('cpu.usage');
    // Own horizons: 2000 h raw, global 30 days for the 5 minute rollup (none given), 900 days for the hourly one.
    expect(s[3].params[0]).toBe(1_700_000_000 - 2000 * 3600);
    expect(s[4].params[0]).toBe(1_700_000_000 - 30 * 86400);
    expect(s[5].params[0]).toBe(1_700_000_000 - 900 * 86400);
  });

  it('keeps the longest retention when several widgets name the same metric', () => {
    const m = mergeDefinitions([
      { pattern: 'cpu.usage', raw_hours: 100, rollup_5m_days: 10, rollup_1h_days: null },
      { pattern: 'cpu.usage', raw_hours: 500, rollup_5m_days: 5, rollup_1h_days: 1000 },
    ], cfg);
    expect(m).toEqual([{ pattern: 'cpu.usage', rawHours: 500, rollup5mDays: 10, rollup1hDays: 1000 }]);
  });

  it('turns metric names into LIKE patterns', () => {
    expect(likeFor('gpu*.vram_mb')).toBe('gpu%.vram!_mb');
  });
});
