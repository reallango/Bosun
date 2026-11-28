import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { validateWidgetSpec, type WidgetSpec } from './spec';
import type { Block } from './spec-v2';
import { validateManifest } from '@/lib/widgets/package-manifest';

const base = (): Record<string, unknown> => ({
  version: 2,
  data: { source: 'snapshot', section: 'services', permission: 'dk.view' },
  actions: [],
  view: { type: 'text', text: '{x}' },
});

const check = (mutate: (s: Record<string, unknown>) => void): ReturnType<typeof validateWidgetSpec> => {
  const s = base();
  mutate(s);
  return validateWidgetSpec(s, ['dk.view']);
};

const layout = (blocks: unknown) => check(s => { s.view = { type: 'layout', blocks }; });

const stat = (item: unknown) => layout([{ type: 'stat', items: [item] }]);

describe('looks in a spec', () => {
  const looks = { default: 'tiles', options: [{ id: 'tiles', label: 'Tiles' }, { id: 'gauges', label: 'Gauges' }] };

  it('are kept, in version 1 and version 2', () => {
    const v2 = check(s => { s.looks = looks; });
    if (!v2.ok) throw new Error(v2.error);
    expect(v2.value.looks).toEqual(looks);
    const v1 = check(s => { s.version = 1; s.looks = looks; });
    expect(v1.ok).toBe(true);
    if (v1.ok) expect(v1.value.looks?.default).toBe('tiles');
  });

  it('are rejected when malformed', () => {
    expect(check(s => { s.looks = { default: 'nope', options: [{ id: 'tiles', label: 'Tiles' }] }; }).ok).toBe(false);
    expect(check(s => { s.looks = { default: 'tiles', options: [] }; }).ok).toBe(false);
    expect(check(s => { s.looks = 'tiles'; }).ok).toBe(false);
  });

  it('leave a spec without them exactly as it was', () => {
    const r = check(() => undefined);
    if (!r.ok) throw new Error(r.error);
    expect('looks' in r.value).toBe(false);
  });
});

describe('trend on a fields item', () => {
  it('is kept and validated', () => {
    const r = validateWidgetSpec({
      version: 1,
      data: { source: 'snapshot', section: 'cpu_memory', permission: 'dk.view' },
      view: { type: 'fields', fields: [{ label: 'CPU', value: '{cpu}', format: 'percent', trend: { metric: 'cpu.usage', window: '1h' } }] },
      actions: [],
    }, ['dk.view']);
    if (!r.ok) throw new Error(r.error);
    expect(r.value.view.fields?.[0].trend).toEqual({ metric: 'cpu.usage', window: '1h' });

    expect(validateWidgetSpec({
      version: 1,
      data: { source: 'snapshot', section: 'cpu_memory', permission: 'dk.view' },
      view: { type: 'fields', fields: [{ label: 'CPU', value: '{cpu}', format: 'percent', trend: { metric: 'CPU', window: '1h' } }] },
      actions: [],
    }, ['dk.view']).ok).toBe(false);
  });
});

describe('stat tiles with bar, unit, trend and thresholds', () => {
  it('keep every new key', () => {
    const r = stat({
      label: 'CPU', value: '{cpu}', bar: '{cpu}', unit: '%',
      trend: { metric: 'cpu.usage', window: '6h' }, thresholds: { warning: 75, danger: 90 },
    });
    if (!r.ok) throw new Error(r.error);
    const block = (r.value.view.blocks?.[0] ?? null) as { items: unknown[] } | null;
    expect(block?.items[0]).toEqual({
      label: 'CPU', value: '{cpu}', bar: '{cpu}', unit: '%',
      trend: { metric: 'cpu.usage', window: '6h' }, thresholds: { warning: 75, danger: 90 },
    });
  });

  it('refuse a malformed trend, thresholds or unit', () => {
    expect(stat({ label: 'A', value: '{a}', trend: { metric: 'a', window: '2h' } }).ok).toBe(false);
    expect(stat({ label: 'A', value: '{a}', thresholds: { warning: 90, danger: 75 } }).ok).toBe(false);
    expect(stat({ label: 'A', value: '{a}', unit: '123456789' }).ok).toBe(false);
    expect(stat({ label: 'A', value: '{a}', bar: 5 }).ok).toBe(false);
  });
});

describe('gauges block', () => {
  it('keeps its items and their optional keys', () => {
    const r = layout([{ type: 'gauges', hideBelow: 'sm', items: [
      { label: 'CPU', value: '{cpu}', max: 100, unit: '%', thresholds: { warning: 75, danger: 90 }, sub: '8 cores' },
      { label: 'Memory', value: '{mem}' },
    ] }]);
    if (!r.ok) throw new Error(r.error);
    const block = r.value.view.blocks?.[0] as { type: string; hideBelow?: string; items: unknown[] };
    expect(block.type).toBe('gauges');
    expect(block.hideBelow).toBe('sm');
    expect(block.items).toEqual([
      { label: 'CPU', value: '{cpu}', max: 100, unit: '%', thresholds: { warning: 75, danger: 90 }, sub: '8 cores' },
      { label: 'Memory', value: '{mem}' },
    ]);
  });

  it('refuses an empty list, a bad item and an unknown option', () => {
    expect(layout([{ type: 'gauges', items: [] }]).ok).toBe(false);
    expect(layout([{ type: 'gauges', items: [{ label: 'CPU' }] }]).ok).toBe(false);
    expect(layout([{ type: 'gauges', items: [{ label: 'CPU', value: '{v}', max: 0 }] }]).ok).toBe(false);
    expect(layout([{ type: 'gauges', items: Array.from({ length: 13 }, () => ({ label: 'C', value: '{v}' })) }]).ok).toBe(false);
  });

  it('takes a condition on the look', () => {
    const r = layout([
      { type: 'stat', when: { field: 'config.look', equals: 'tiles' }, items: [{ label: 'CPU', value: '{cpu}' }] },
      { type: 'gauges', when: { field: 'config.look', equals: 'gauges' }, items: [{ label: 'CPU', value: '{cpu}' }] },
    ]);
    if (!r.ok) throw new Error(r.error);
    expect(r.value.view.blocks?.map(b => (b as { when?: unknown }).when)).toEqual([
      { field: 'config.look', equals: 'tiles' },
      { field: 'config.look', equals: 'gauges' },
    ]);
  });
});

describe('count and format on stat tiles', () => {
  it('takes a count instead of a value, with an optional path and condition', () => {
    const r = stat({ label: 'Models', count: { path: 'data.tags.models', where: { field: 'state', equals: 'running' } } });
    if (!r.ok) throw new Error(r.error);
    const block = (r.value.view.blocks?.[0] ?? null) as { items: unknown[] } | null;
    expect(block?.items[0]).toEqual({ label: 'Models', count: { path: 'data.tags.models', where: { field: 'state', equals: 'running' } } });
  });

  it('needs a value or a count, and refuses a bad path or condition', () => {
    expect(stat({ label: 'A' }).ok).toBe(false);
    expect(stat({ label: 'A', count: { path: 'data[0]' } }).ok).toBe(false);
    expect(stat({ label: 'A', count: { where: { field: 'x' } } }).ok).toBe(false);
    expect(stat({ label: 'A', count: 'data' }).ok).toBe(false);
  });

  it('keeps a value format, and refuses an unknown one', () => {
    const r = stat({ label: 'Traffic', value: '{rate}', format: 'rate' });
    if (!r.ok) throw new Error(r.error);
    expect((r.value.view.blocks?.[0] as { items: { format?: string }[] }).items[0].format).toBe('rate');
    expect(stat({ label: 'A', value: '{a}', format: 'nope' }).ok).toBe(false);
    expect(layout([{ type: 'gauges', items: [{ label: 'VRAM', value: '{v}', max: 12288, format: 'mb' }] }]).ok).toBe(true);
    expect(layout([{ type: 'gauges', items: [{ label: 'VRAM', value: '{v}', format: 'nope' }] }]).ok).toBe(false);
  });
});

describe('meters block', () => {
  it('keeps a path, shape, row template and empty text', () => {
    const r = layout([{ type: 'meters', path: 'data.mounts', shape: 'bar', empty: 'No mounts', item: { label: '{mount}', value: '{used_pct}', unit: '%', sub: '{fs}', thresholds: { warning: 80, danger: 90 } } }]);
    if (!r.ok) throw new Error(r.error);
    const block = r.value.view.blocks?.[0] as { type: string; path?: string; shape?: string; empty?: string; item: unknown };
    expect(block.type).toBe('meters');
    expect(block.path).toBe('data.mounts');
    expect(block.shape).toBe('bar');
    expect(block.empty).toBe('No mounts');
    expect(block.item).toEqual({ label: '{mount}', value: '{used_pct}', unit: '%', sub: '{fs}', thresholds: { warning: 80, danger: 90 } });
  });

  it('defaults to a bar and refuses a bad shape, item or path', () => {
    const r = layout([{ type: 'meters', item: { label: '{name}', value: '{pct}' } }]);
    if (!r.ok) throw new Error(r.error);
    expect((r.value.view.blocks?.[0] as { shape?: string }).shape).toBe('bar');
    expect(layout([{ type: 'meters', shape: 'pie', item: { label: '{x}', value: '{y}' } }]).ok).toBe(false);
    expect(layout([{ type: 'meters', item: { label: '{x}' } }]).ok).toBe(false);
    expect(layout([{ type: 'meters', path: 'data[0]', item: { label: '{x}', value: '{y}' } }]).ok).toBe(false);
  });
});

describe('the CPU/Memory reference adoption', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'widgets', 'cpu_memory', 'manifest.json'), 'utf8'));
  const manifest = validateManifest(raw);
  if (!manifest.ok) throw new Error(manifest.error);
  const spec = manifest.value.widgets[0].spec as WidgetSpec;

  it('needs the new API level and a version past the one it ever had', () => {
    expect(manifest.value.requires).toEqual({ api: 13 });
    expect(manifest.value.version).toBe('1.2.0');
  });

  it('offers Tiles, Gauges and Cores with Tiles as the default', () => {
    expect(spec.looks).toEqual({
      default: 'tiles',
      options: [
        { id: 'tiles', label: 'Tiles' },
        { id: 'gauges', label: 'Gauges' },
        { id: 'cores', label: 'Cores', min_size: { w: 8, h: 6 }, default_size: { w: 10, h: 6 } },
      ],
    });
  });

  it('draws one threshold-coloured bar per core, labelled with its number', () => {
    const cores = spec.view.blocks?.find(b => b.type === 'meters') as Extract<Block, { type: 'meters' }> | undefined;
    expect(cores?.path).toBe('cpu.cores');
    expect(cores?.layout).toBe('grid');
    expect(cores?.when).toEqual({ field: 'config.look', equals: 'cores' });
    expect(cores?.item).toEqual({ label: '{id}', value: '{usagePercent}', unit: '%', thresholds: { warning: 75, danger: 90 } });
  });

  it('draws CPU and Memory as tiles with trends, bars and thresholds, and as ring gauges', () => {
    const blocks = spec.view.blocks ?? [];
    const tiles = blocks.find(b => b.type === 'stat') as Extract<Block, { type: 'stat' }>;
    const gauges = blocks.find(b => b.type === 'gauges') as Extract<Block, { type: 'gauges' }>;
    expect(tiles.when).toEqual({ field: 'config.look', equals: 'tiles' });
    expect(gauges.when).toEqual({ field: 'config.look', equals: 'gauges' });
    expect(tiles.items.map(i => i.label)).toEqual(['CPU', 'Memory']);
    expect(gauges.items!.map(i => i.label)).toEqual(['CPU', 'Memory']);
    for (const tile of tiles.items) {
      expect(tile.trend?.window).toBe('1h');
      expect(tile.bar).toBeDefined();
      expect(tile.thresholds).toEqual({ warning: 75, danger: 90 });
    }
    for (const gauge of gauges.items!) {
      expect(gauge.max).toBe(100);
      expect(gauge.thresholds).toEqual({ warning: 75, danger: 90 });
    }
  });

  it('keeps load, temperature and swap in one quiet text line', () => {
    const line = spec.view.blocks?.find(b => b.type === 'text') as Extract<Block, { type: 'text' }> | undefined;
    expect(line?.text).toContain('{data.cpu.loadAvg1}');
    expect(line?.text).toContain('{data.cpu.temperature}');
    expect(line?.text).toContain('{data.memory.swapUsedMB}');
  });
});

describe('sizing knobs on stat and gauges blocks', () => {
  it('keeps block sizing and item emphasis and decimals', () => {
    const r = layout([
      { type: 'stat', size: 'lg', minItemWidth: 'sm', columns: 2, items: [
        { label: 'CPU', value: '{cpu}', unit: '%', decimals: 2, emphasis: 'muted' },
      ] },
      { type: 'gauges', size: 'sm', minItemWidth: 'lg', columns: 3, thickness: 'thick', items: [
        { label: 'Memory', value: '{mem}', unit: '%', decimals: 0, emphasis: 'normal', thickness: 'thin' },
      ] },
    ]);
    if (!r.ok) throw new Error(r.error);
    expect(r.value.view.blocks?.[0]).toMatchObject({ size: 'lg', minItemWidth: 'sm', columns: 2 });
    expect(r.value.view.blocks?.[0]).toMatchObject({ items: [{ decimals: 2, emphasis: 'muted' }] });
    expect(r.value.view.blocks?.[1]).toMatchObject({ size: 'sm', minItemWidth: 'lg', columns: 3, thickness: 'thick' });
    expect(r.value.view.blocks?.[1]).toMatchObject({ items: [{ decimals: 0, emphasis: 'normal', thickness: 'thin' }] });
  });

  it('refuses an unknown size, minimum width, column count, emphasis, decimals or thickness', () => {
    const items = [{ label: 'CPU', value: '{cpu}' }];
    expect(layout([{ type: 'stat', size: 'xl', items }]).ok).toBe(false);
    expect(layout([{ type: 'stat', minItemWidth: 'huge', items }]).ok).toBe(false);
    expect(layout([{ type: 'stat', columns: 7, items }]).ok).toBe(false);
    expect(layout([{ type: 'stat', items: [{ ...items[0], decimals: 4 }] }]).ok).toBe(false);
    expect(layout([{ type: 'stat', items: [{ ...items[0], emphasis: 'loud' }] }]).ok).toBe(false);
    expect(layout([{ type: 'gauges', thickness: 'wide', items }]).ok).toBe(false);
    expect(layout([{ type: 'gauges', items: [{ ...items[0], thickness: 'wide' }] }]).ok).toBe(false);
  });
});

describe('widget density', () => {
  it('is kept and validated', () => {
    const r = check(s => { s.density = 'compact'; });
    if (!r.ok) throw new Error(r.error);
    expect(r.value.density).toBe('compact');
    expect(check(s => { s.density = 'dense'; }).ok).toBe(false);
  });
});
