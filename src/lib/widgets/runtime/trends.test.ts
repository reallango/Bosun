import { describe, it, expect } from 'vitest';
import { collectTrends, shapeSparkline, sparklinePath, trendRequest, trendWindowSec, validateTrend } from './trends';

describe('validateTrend', () => {
  it('accepts a metric name and one of the windows', () => {
    expect(validateTrend(undefined, 'x')).toEqual({ ok: true, value: undefined });
    expect(validateTrend({ metric: 'cpu.usage', window: '1h' }, 'x')).toEqual({ ok: true, value: { metric: 'cpu.usage', window: '1h' } });
    expect(validateTrend({ metric: 'mem.used_pct', window: '24h' }, 'x').ok).toBe(true);
  });

  it('refuses a bad metric name, a window it cannot draw or a value that is not an object', () => {
    expect(validateTrend({ metric: 'CPU.Usage', window: '1h' }, 'x').ok).toBe(false);
    expect(validateTrend({ metric: 'cpu usage', window: '1h' }, 'x').ok).toBe(false);
    expect(validateTrend({ metric: 'cpu.usage', window: '2h' }, 'x').ok).toBe(false);
    expect(validateTrend({ metric: 'cpu.usage' }, 'x').ok).toBe(false);
    expect(validateTrend('cpu.usage', 'x').ok).toBe(false);
  });
});

describe('collectTrends', () => {
  it('finds every trend in nested blocks and fields, once each', () => {
    const view = {
      type: 'layout',
      blocks: [
        { type: 'stat', items: [
          { label: 'CPU', value: '{a}', trend: { metric: 'cpu.usage', window: '1h' } },
          { label: 'Memory', value: '{b}', trend: { metric: 'mem.used_pct', window: '6h' } },
        ] },
        { type: 'section', title: 'More', blocks: [
          { type: 'kv', items: [{ label: 'CPU', value: '{a}', trend: { metric: 'cpu.usage', window: '1h' } }] },
        ] },
        { type: 'stat', items: [{ label: 'Other', value: '{c}', trend: { metric: 'cpu.usage', window: '24h' } }] },
      ],
      fields: [{ label: 'Load', value: '{l}', trend: { metric: 'cpu.load1', window: '1h' } }],
    };
    expect(collectTrends(view)).toEqual([
      { metric: 'cpu.usage', window: '1h' },
      { metric: 'mem.used_pct', window: '6h' },
      { metric: 'cpu.usage', window: '24h' },
      { metric: 'cpu.load1', window: '1h' },
    ]);
  });

  it('ignores a trend-shaped object that is not a valid trend', () => {
    expect(collectTrends({ blocks: [{ type: 'stat', items: [{ trend: { metric: 'CPU', window: '1h' } }] }] })).toEqual([]);
    expect(collectTrends(null)).toEqual([]);
  });
});

describe('trendRequest', () => {
  it('asks once for all the metrics and the widest window', () => {
    expect(trendRequest([])).toBeNull();
    expect(trendRequest([
      { metric: 'cpu.usage', window: '1h' },
      { metric: 'mem.used_pct', window: '24h' },
      { metric: 'cpu.usage', window: '6h' },
    ])).toEqual({ metrics: ['cpu.usage', 'mem.used_pct'], range: '24h' });
  });

  it('caps the metric list at what the metrics API takes', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ metric: `m.${i}`, window: '1h' as const }));
    expect(trendRequest(many)?.metrics).toHaveLength(12);
  });
});

describe('shapeSparkline', () => {
  const now = 1_000_000;
  const points = [
    { t: now - 7200, avg: 10 },
    { t: now - 1800, avg: 30 },
    { t: now - 60, avg: 20 },
    { t: now - 30, avg: Number.NaN },
  ];

  it('keeps only the points inside the window, oldest first', () => {
    expect(shapeSparkline(points, trendWindowSec('1h'), now)).toEqual([
      { t: now - 1800, v: 30 },
      { t: now - 60, v: 20 },
    ]);
    expect(shapeSparkline(points, trendWindowSec('6h'), now).map(p => p.v)).toEqual([10, 30, 20]);
  });

  it('draws nothing when there is no usable history', () => {
    expect(shapeSparkline([], 3600, now)).toEqual([]);
    expect(shapeSparkline([{ t: now, avg: Number.NaN }], 3600, now)).toEqual([]);
  });
});

describe('sparklinePath', () => {
  it('is empty without points and a single move for one point', () => {
    expect(sparklinePath([])).toBe('');
    expect(sparklinePath([{ t: 0, v: 5 }])).toBe('M50,15');
  });

  it('draws from the left edge to the right edge, lowest value at the bottom', () => {
    expect(sparklinePath([{ t: 0, v: 0 }, { t: 10, v: 10 }], 100, 30, 2)).toBe('M2,28 L98,2');
  });

  it('keeps a flat line in the middle', () => {
    expect(sparklinePath([{ t: 0, v: 5 }, { t: 10, v: 5 }], 100, 30, 2)).toBe('M2,15 L98,15');
  });
});
