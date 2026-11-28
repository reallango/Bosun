import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { balancedArrangement, type ArrangementKind } from '@/lib/widgets/runtime/arrangement';
import { ItemGridBox } from './ItemGrid';

const grid = (n: number, width: number, height: number, kind: ArrangementKind): string =>
  renderToStaticMarkup(createElement(
    ItemGridBox,
    { arrangement: balancedArrangement(n, width, height, kind, 8), gap: 8, className: 'grid h-full min-h-0' },
    createElement('span', null, 'tile'),
  ));

describe('ItemGridBox', () => {
  it('writes the measured arrangement into the grid template', () => {
    // Six gauges in a wide box: one row; in a square box: three columns of two.
    expect(grid(6, 800, 200, 'gauges')).toContain('grid-template-columns:repeat(6, minmax(0, 1fr))');
    expect(grid(6, 800, 200, 'gauges')).toContain('grid-template-rows:repeat(1, minmax(0, 1fr))');
    expect(grid(6, 400, 400, 'gauges')).toContain('grid-template-columns:repeat(3, minmax(0, 1fr))');
    expect(grid(6, 400, 400, 'gauges')).toContain('grid-template-rows:repeat(2, minmax(0, 1fr))');
    // Six tiles in a tall box: a single column.
    expect(grid(6, 200, 800, 'stat')).toContain('grid-template-columns:repeat(1, minmax(0, 1fr))');
    expect(grid(6, 200, 800, 'stat')).toContain('grid-template-rows:repeat(6, minmax(0, 1fr))');
  });

  it('keeps the cell gap with the template', () => {
    expect(grid(2, 600, 240, 'gauges')).toContain('gap:8px');
  });

  it('leaves the template to the class before the box is measured', () => {
    const html = renderToStaticMarkup(createElement(
      ItemGridBox,
      { arrangement: null, className: 'grid h-full' },
      createElement('span', null, 'tile'),
    ));
    expect(html).not.toContain('grid-template-columns');
    expect(html).not.toContain('grid-template-rows');
    expect(html).toContain('class="grid h-full"');
  });
});
