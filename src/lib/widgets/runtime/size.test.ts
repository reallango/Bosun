import { describe, it, expect } from 'vitest';
import { fitsSize, sizeClassFor, splitActions, validateHideBelow, validateInline } from './size';
import { validateWidgetSpec } from './spec';

describe('widget size classes', () => {
  it('come from the width of the widget content box', () => {
    expect(sizeClassFor(200)).toBe('xs');
    expect(sizeClassFor(279)).toBe('xs');
    expect(sizeClassFor(280)).toBe('sm');
    expect(sizeClassFor(419)).toBe('sm');
    expect(sizeClassFor(420)).toBe('md');
    expect(sizeClassFor(640)).toBe('lg');
    expect(sizeClassFor(2000)).toBe('lg');
  });

  it('count as the largest before the widget is measured, so nothing hides early', () => {
    expect(sizeClassFor(0)).toBe('lg');
    expect(sizeClassFor(Number.NaN)).toBe('lg');
  });

  it('hide a part only below its hideBelow', () => {
    expect(fitsSize({}, 'xs')).toBe(true);
    expect(fitsSize({ hideBelow: 'md' }, 'sm')).toBe(false);
    expect(fitsSize({ hideBelow: 'md' }, 'md')).toBe(true);
    expect(fitsSize({ hideBelow: 'md' }, 'lg')).toBe(true);
  });
});

describe('splitActions', () => {
  const six = ['a', 'b', 'c', 'd', 'e', 'f'];

  it('keeps every action a button on large widgets', () => {
    expect(splitActions(six, 'lg')).toEqual({ shown: six, more: [] });
  });

  it('moves the rest into the "more" menu on small widgets, keeping the order', () => {
    expect(splitActions(six, 'sm')).toEqual({ shown: ['a', 'b', 'c'], more: ['d', 'e', 'f'] });
    expect(splitActions(six, 'xs')).toEqual({ shown: ['a'], more: ['b', 'c', 'd', 'e', 'f'] });
  });

  it('never makes a menu for a single action', () => {
    expect(splitActions(['a', 'b'], 'xs')).toEqual({ shown: ['a', 'b'], more: [] });
    expect(splitActions(['a', 'b', 'c', 'd'], 'sm')).toEqual({ shown: ['a', 'b', 'c', 'd'], more: [] });
  });

  it('follows the spec, taking the nearest smaller size it names', () => {
    expect(splitActions(six, 'xs', { xs: 0 })).toEqual({ shown: [], more: six });
    expect(splitActions(six, 'md', { sm: 2 })).toEqual({ shown: ['a', 'b'], more: ['c', 'd', 'e', 'f'] });
    // lg not named and nothing smaller named either: the default (all) applies.
    expect(splitActions(six, 'lg', { lg: undefined })).toEqual({ shown: six, more: [] });
  });
});

describe('size hints in a spec', () => {
  it('validate hideBelow and inline', () => {
    expect(validateHideBelow(undefined, 'x')).toEqual({ ok: true, value: {} });
    expect(validateHideBelow('sm', 'x')).toEqual({ ok: true, value: { hideBelow: 'sm' } });
    expect(validateHideBelow('xs', 'x').ok).toBe(false);
    expect(validateHideBelow(3, 'x').ok).toBe(false);
    expect(validateInline({ xs: 0, md: 4 }, 'x')).toEqual({ ok: true, value: { xs: 0, md: 4 } });
    expect(validateInline({ tiny: 1 }, 'x').ok).toBe(false);
    expect(validateInline({ xs: 11 }, 'x').ok).toBe(false);
    expect(validateInline([1], 'x').ok).toBe(false);
  });

  const spec = (view: object): unknown => ({
    version: 1,
    data: { source: 'command', as: 'service', parse: 'jsonlines', cacheSec: 10, permission: 'p.view', command: 'list-things' },
    view,
    actions: [
      { id: 'a', label: 'A', permission: 'p.view', as: 'service', command: 'do-a' },
      { id: 'b', label: 'B', permission: 'p.view', as: 'service', command: 'do-b' },
    ],
  });

  it('are kept by the validator on lists, tables, fields, summary, filter and toggles', () => {
    const r = validateWidgetSpec(spec({
      type: 'list',
      summary: [{ label: 'total', hideBelow: 'sm' }],
      filter: { fields: ['name'], hideBelow: 'md' },
      toggles: [{ key: 't', label: 'T', hideWhen: { field: 'x', equals: 1 }, hideBelow: 'sm' }],
      row: { title: '{name}', subtitle: '{image}', subtitleHideBelow: 'sm', inline: { xs: 0, sm: 1 }, actions: ['a', 'b'], fields: [{ label: 'CPU', value: '{cpu}', hideBelow: 'md' }] },
    }), ['p.view']);
    if (!r.ok) throw new Error(r.error);
    const v = r.value.view;
    expect(v.summary?.[0].hideBelow).toBe('sm');
    expect(v.filter?.hideBelow).toBe('md');
    expect(v.toggles?.[0].hideBelow).toBe('sm');
    expect(v.row?.subtitleHideBelow).toBe('sm');
    expect(v.row?.inline).toEqual({ xs: 0, sm: 1 });
    expect(v.row?.fields?.[0].hideBelow).toBe('md');

    const t = validateWidgetSpec(spec({ type: 'table', columns: [{ title: 'Name', value: '{name}' }, { title: 'Image', value: '{image}', hideBelow: 'md' }] }), ['p.view']);
    if (!t.ok) throw new Error(t.error);
    expect(t.value.view.columns?.map(c => c.hideBelow)).toEqual([undefined, 'md']);
  });

  it('are rejected when malformed, so an author learns about a typo', () => {
    expect(validateWidgetSpec(spec({ type: 'list', row: { title: '{n}', inline: { huge: 1 }, actions: [] } }), ['p.view']).ok).toBe(false);
    expect(validateWidgetSpec(spec({ type: 'table', columns: [{ title: 'N', value: '{n}', hideBelow: 'tiny' }] }), ['p.view']).ok).toBe(false);
  });

  it('leave a spec without them exactly as it was', () => {
    const r = validateWidgetSpec(spec({ type: 'list', row: { title: '{name}', actions: ['a'] } }), ['p.view']);
    if (!r.ok) throw new Error(r.error);
    expect(r.value.view.row).toEqual({ title: '{name}', actions: ['a'] });
  });
});
