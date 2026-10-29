import { describe, it, expect } from 'vitest';
import { planQuery, describeMetric, describeFromDefinitions, MAX_POINTS, RANGES } from './query';

describe('planQuery', () => {
  const raw48h = 48 * 3600;
  it('uses raw samples for short ranges', () => {
    expect(planQuery(RANGES['1h'], raw48h)).toEqual({ source: 'raw', step: 9 });
    expect(planQuery(RANGES['24h'], raw48h).source).toBe('raw');
  });
  it('falls back to rollups when raw retention is shorter than the range', () => {
    expect(planQuery(RANGES['24h'], 6 * 3600).source).toBe('rollup_5m');
  });
  it('uses 5m rollups up to 30 days and 1h beyond', () => {
    expect(planQuery(RANGES['7d'], raw48h)).toEqual({ source: 'rollup_5m', step: 1800 });
    expect(planQuery(RANGES['1y'], raw48h).source).toBe('rollup_1h');
  });
  it('never returns more than MAX_POINTS buckets and keeps steps aligned to the source', () => {
    for (const sec of Object.values(RANGES)) {
      const p = planQuery(sec, raw48h);
      expect(Math.ceil(sec / p.step)).toBeLessThanOrEqual(MAX_POINTS);
      if (p.source === 'rollup_5m') expect(p.step % 300).toBe(0);
      if (p.source === 'rollup_1h') expect(p.step % 3600).toBe(0);
    }
  });
});

describe('describeMetric', () => {
  it('labels known and gpu metrics', () => {
    expect(describeMetric('cpu.usage')).toEqual({ label: 'CPU usage', unit: '%' });
    expect(describeMetric('gpu1.vram_mb')).toEqual({ label: 'GPU 1 VRAM used', unit: 'MB' });
    expect(describeMetric('weird.metric')).toEqual({ label: 'weird.metric', unit: '' });
  });
});

describe('describeFromDefinitions', () => {
  const defs = [{ pattern: 'dk.running', label: 'Running containers', unit: '' }, { pattern: 'gpu*.fan', label: 'GPU fan', unit: '%' }];
  it('labels metrics a package declared and leaves the built-in ones alone', () => {
    expect(describeFromDefinitions(defs, 'dk.running', { label: 'dk.running', unit: '' })).toEqual({ label: 'Running containers', unit: '' });
    expect(describeFromDefinitions(defs, 'gpu1.fan', { label: 'gpu1.fan', unit: '' })).toEqual({ label: 'GPU fan', unit: '%' });
    expect(describeFromDefinitions(defs, 'cpu.usage', { label: 'CPU usage', unit: '%' })).toEqual({ label: 'CPU usage', unit: '%' });
    expect(describeFromDefinitions(defs, 'other.x', { label: 'other.x', unit: '' })).toEqual({ label: 'other.x', unit: '' });
  });
});
