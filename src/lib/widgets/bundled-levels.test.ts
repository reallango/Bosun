import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { catalogIds, readBundledPackages, widgetsDir } from './bundled';
import { requiredApiLevel } from './api-level';

/**
 * The minimum widget API level a manifest needs, derived from the spec keys it uses, following the history table in
 * widgets/README.md. An older Bosun cannot honour these keys (it would render the widget wrongly or refuse it), so a
 * package that uses one must declare a level at least this high: `requires.api` is what defers the package's install
 * until every node of the cluster can run it.
 */
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const given = (o: Obj, k: string) => o[k] !== undefined;

interface Size { w: number; h: number }
const size = (v: unknown): Size | null => {
  if (!isObj(v)) return null;
  const w = Number(v.w);
  const h = Number(v.h);
  return Number.isFinite(w) && Number.isFinite(h) ? { w, h } : null;
};

/** The level one block asks for (a stat block alone is level 4, its newer keys add more). */
function blockLevel(b: Obj, widgetDefault: Size | null): number {
  let level = 0;
  const bump = (n: number) => { level = Math.max(level, n); };
  const items = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : []);
  const itemLevel = (item: Obj, gauge: boolean) => {
    for (const it of [item, ...items(item.alternatives)]) {
      if (given(it, 'trend') || given(it, 'bar') || given(it, 'unit') || given(it, 'thresholds')) bump(7);
      if (given(it, 'emphasis') || given(it, 'decimals')) bump(8);
      if (given(it, 'count') || given(it, 'format')) bump(10);
      if (given(it, 'when') || given(it, 'alternatives')) bump(11);
      // A gauge item's own "format" arrived with the levels that added the ring keys.
      if (gauge && given(it, 'format')) bump(10);
    }
  };
  switch (b.type) {
    case 'stat': {
      bump(4);
      if (given(b, 'size') || given(b, 'minItemWidth') || given(b, 'columns')) bump(8);
      if (given(b, 'footer')) bump(11);
      for (const it of items(b.items)) itemLevel(it, false);
      for (const f of items(b.footer)) if (given(f, 'format')) bump(13);
      break;
    }
    case 'gauges': {
      bump(7);
      if (given(b, 'size') || given(b, 'minItemWidth') || given(b, 'columns') || given(b, 'thickness')) bump(8);
      if (given(b, 'footer')) bump(11);
      if (given(b, 'path') && given(b, 'item')) bump(13);
      for (const it of items(b.items)) itemLevel(it, true);
      if (isObj(b.item)) itemLevel(b.item, true);
      for (const f of items(b.footer)) if (given(f, 'format')) bump(13);
      break;
    }
    case 'meters': {
      bump(10);
      if (given(b, 'layout')) bump(11);
      if (isObj(b.item)) itemLevel(b.item, false);
      break;
    }
    case 'info': {
      bump(11);
      for (const it of items(b.items)) if (given(it, 'format')) bump(13);
      break;
    }
    case 'tabs': {
      for (const t of items(b.tabs)) {
        if (given(t, 'count')) bump(4);
        if (Array.isArray(t.blocks)) for (const inner of t.blocks) if (isObj(inner)) bump(blockLevel(inner, widgetDefault));
      }
      break;
    }
    case 'section': {
      if (Array.isArray(b.blocks)) for (const inner of b.blocks) if (isObj(inner)) bump(blockLevel(inner, widgetDefault));
      break;
    }
    case 'editor': {
      if (b.open === 'dialog') bump(4);
      if (Array.isArray(b.fields)) for (const f of b.fields) if (isObj(f) && given(f, 'credentialsKind')) bump(12);
      break;
    }
    case 'credentials': bump(12); break;
    default: break;
  }
  return level;
}

/** The level a view asks for, wherever a view can nest. */
function viewLevel(view: Obj, widgetDefault: Size | null): number {
  let level = 1;
  const bump = (n: number) => { level = Math.max(level, n); };
  const walk = (v: Obj) => {
    if (given(v, 'defaultSort') || given(v, 'open')) bump(4);
    if (given(v, 'bulk')) bump(4);
    if (Array.isArray(v.blocks)) {
      for (const b of v.blocks) if (isObj(b)) bump(blockLevel(b, widgetDefault));
    }
    if (isObj(v.row)) {
      if (given(v.row, 'inline') || given(v.row, 'subtitleHideBelow')) bump(3);
    }
    if (Array.isArray(v.columns)) for (const c of v.columns) if (isObj(c) && given(c, 'sort')) bump(4);
    if (Array.isArray(v.fields)) for (const f of v.fields) if (isObj(f)) { if (given(f, 'trend')) bump(7); if (v.format === 'rate' || f.format === 'rate') bump(10); }
    if (v.gauge && isObj(v.gauge)) { bump(7); if (given(v.gauge, 'format')) bump(10); }
  };
  walk(view);
  return level;
}

/** The level one widget of a manifest asks for. */
function widgetLevel(w: Obj): number {
  let level = 1;
  const bump = (n: number) => { level = Math.max(level, n); };
  const spec = isObj(w.spec) ? w.spec : null;
  if (!spec) return level;
  if (spec.version === 2) bump(2);
  if (given(spec, 'scripts') || given(spec, 'state') || given(spec, 'lookups') || given(spec, 'schedules') || given(spec, 'screens') || given(spec, 'datasets') || given(spec, 'menu') || given(spec, 'resources')) bump(2);
  if (given(spec, 'schedules')) bump(5);
  if (given(spec, 'credentials')) bump(12);
  if (Array.isArray(spec.actions) && spec.actions.length > 40) bump(6);
  if (isObj(spec.stacks)) {
    const st = spec.stacks;
    if (given(st, 'retag') || given(st, 'deployLater') || given(st, 'deployPrivilegedLater') || given(st, 'setup')) bump(3);
  }
  if (given(spec, 'setup')) bump(3);
  if (given(spec, 'density')) bump(8);

  const widgetDefault = size(w.default_size);
  const specLooks = isObj(spec.looks) ? spec.looks : null;
  if (specLooks) {
    bump(7);
    for (const o of Array.isArray(specLooks.options) ? specLooks.options : []) {
      if (!isObj(o)) continue;
      const min = size(o.min_size);
      const dflt = size(o.default_size);
      if (min || dflt) bump(11);
      // Level 13 lets a look ask for more room than the widget's own default size.
      if (widgetDefault && ((min && (min.w > widgetDefault.w || min.h > widgetDefault.h)) || (dflt && (dflt.w > widgetDefault.w || dflt.h > widgetDefault.h)))) bump(13);
    }
  }

  for (const a of Array.isArray(spec.actions) ? spec.actions : []) {
    if (!isObj(a)) continue;
    if (isObj(a.target) && given(a.target, 'byKind')) bump(9);
    if (Array.isArray(a.variants)) for (const v of a.variants) if (isObj(v) && given(v, 'before')) bump(9);
    if (isObj(a.params)) for (const p of Object.values(a.params)) {
      if (isObj(p) && (p.type === 'text' || given(p, 'maxLines') || given(p, 'linePattern'))) bump(2);
      if (isObj(p) && p.format === 'rate') bump(10);
    }
  }
  for (const ds of isObj(spec.datasets) ? Object.values(spec.datasets) : []) {
    if (isObj(ds) && isObj(ds.target) && given(ds.target, 'byKind')) bump(9);
    if (isObj(ds) && isObj(ds.params)) for (const p of Object.values(ds.params)) if (isObj(p) && p.format === 'rate') bump(10);
  }
  for (const s of isObj(spec.scripts) ? Object.values(spec.scripts) : []) {
    if (isObj(s) && isObj(s.params)) for (const p of Object.values(s.params)) {
      if (isObj(p) && (p.type === 'text' || given(p, 'maxLines') || given(p, 'linePattern'))) bump(2);
      if (isObj(p) && p.format === 'rate') bump(10);
    }
  }

  // Metrics read by a dotted key (`{data.metrics.cpu.usage}`) are level 10; a metric declared with a dotted name is not.
  const templates = JSON.stringify(spec.view ?? {});
  if (/\{metrics\.[a-z0-9_]+\.[a-z0-9_.]+\}/i.test(templates)) bump(10);

  if (isObj(spec.view)) bump(viewLevel(spec.view, widgetDefault));
  for (const sc of isObj(spec.screens) ? Object.values(spec.screens) : []) {
    if (!isObj(sc)) continue;
    if (isObj(sc.view)) bump(viewLevel(sc.view, widgetDefault));
    if (isObj(sc.layout)) bump(viewLevel(sc.layout, widgetDefault));
  }
  return level;
}

function manifestLevel(raw: Obj): number {
  let level = 1;
  for (const w of Array.isArray(raw.widgets) ? raw.widgets : []) {
    if (isObj(w)) level = Math.max(level, widgetLevel(w));
  }
  if (given(raw, 'credentials')) level = Math.max(level, 12);
  return level;
}

describe('every bundled package declares the API level it uses', () => {
  const ids = catalogIds();

  it('has a readable manifest', () => {
    expect(ids.length).toBeGreaterThan(0);
  });

  for (const id of ids) {
    it(`${id} declares requires.api at least the level its spec needs`, () => {
      const raw = JSON.parse(fs.readFileSync(path.join(widgetsDir(), id, 'manifest.json'), 'utf8')) as Obj;
      const needed = manifestLevel(raw);
      const declared = requiredApiLevel(isObj(raw.requires) ? (raw.requires as never) : undefined);
      // Derived from the README's history table; 13 is the newest level this build knows.
      expect(needed).toBeLessThanOrEqual(13);
      expect(declared).toBeGreaterThanOrEqual(needed);
    });
  }

  it('still validates every bundled package with the current validator', () => {
    const { errors, packages } = readBundledPackages(undefined, ids);
    expect(errors).toEqual([]);
    expect(packages.map(p => p.manifest.id).sort()).toEqual([...ids].sort());
  });
});
