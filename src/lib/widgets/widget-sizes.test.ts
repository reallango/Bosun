import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// Every widget of every bundled package: its default size can never be below its smallest size, both fit the grid, and the
// smallest size is big enough to show the widget (the floor per kind of screen is in MIN_FLOOR; the real fit is checked in
// the browser, see docs/plans/widget-self-containment.md, phase 10).
const GRID_COLS_LG = 24;
const dir = path.join(process.cwd(), 'widgets');
const widgets: { id: string; type: string; def: { w: number; h: number }; min: { w: number; h: number }; view: string; blocks: number }[] = [];
for (const id of fs.readdirSync(dir)) {
  const f = path.join(dir, id, 'manifest.json');
  if (id.startsWith('_') || !fs.existsSync(f)) continue;
  for (const w of JSON.parse(fs.readFileSync(f, 'utf8')).widgets ?? []) {
    widgets.push({ id, type: w.type, def: w.default_size, min: w.min_size ?? { w: 1, h: 1 }, view: w.spec?.view?.type ?? '', blocks: w.spec?.view?.blocks?.length ?? 0 });
  }
}

/** Smallest sensible box per kind of screen: a chart or table needs room, a few labelled values do not. */
const MIN_FLOOR: Record<string, { w: number; h: number }> = { chart: { w: 6, h: 4 }, table: { w: 5, h: 4 }, layout: { w: 4, h: 3 }, list: { w: 4, h: 3 }, fields: { w: 4, h: 3 }, text: { w: 4, h: 3 } };

describe('widget sizes of the bundled packages', () => {
  it('finds the bundled widgets', () => expect(widgets.length).toBeGreaterThanOrEqual(12));
  for (const w of widgets) {
    it(`${w.type}: default >= smallest, both inside the grid, smallest not below the floor of its screen`, () => {
      expect(w.def.w, 'default width').toBeGreaterThanOrEqual(w.min.w);
      expect(w.def.h, 'default height').toBeGreaterThanOrEqual(w.min.h);
      expect(w.def.w).toBeLessThanOrEqual(GRID_COLS_LG);
      expect(w.min.w).toBeGreaterThanOrEqual(1);
      const floor = MIN_FLOOR[w.view] ?? { w: 4, h: 3 };
      expect(w.min.w, 'smallest width').toBeGreaterThanOrEqual(floor.w);
      expect(w.min.h, 'smallest height').toBeGreaterThanOrEqual(floor.h);
    });
  }
});
