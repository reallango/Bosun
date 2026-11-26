import { describe, it, expect } from 'vitest';
import type { ViewSpec } from './spec';
import { bulkCandidates, bulkNames, rowKey, rowLabel, selectAll, selectedRows, toggleSelected, type BulkActionLike } from './bulk';

interface TestAction extends BulkActionLike { confirm?: { destructive?: boolean } }

const table = (over: Partial<ViewSpec> = {}): ViewSpec => ({
  type: 'table',
  columns: [{ title: 'Name', value: '{name}', format: 'text' }, { title: 'State', value: '{state}', format: 'text' }],
  rowActions: ['stop', 'start', 'remove'],
  bulk: ['stop', 'start', 'remove'],
  ...over,
});

const rowParam = { params: { name: { from: 'name' } } };
const actions = new Map<string, TestAction>([
  ['stop', { id: 'stop', label: 'Stop', kind: 'script', when: { field: 'state', equals: 'running' }, ...rowParam }],
  ['start', { id: 'start', label: 'Start', kind: 'script', when: { field: 'state', notEquals: 'running' }, ...rowParam }],
  ['remove', { id: 'remove', label: 'Remove', kind: 'script', confirm: { destructive: true }, ...rowParam }],
  ['open', { id: 'open', label: 'Open', kind: 'screen' }],
  ['shell', { id: 'shell', label: 'Shell', kind: 'terminal' }],
  ['prune', { id: 'prune', label: 'Prune', kind: 'script' }],
]);

const rows = [
  { name: 'web', state: 'running' },
  { name: 'db', state: 'running' },
  { name: 'old', state: 'exited' },
];
const all = new Set(rows.map(rowKey));

describe('row identity and names', () => {
  it('gives equal rows the same key and different rows different keys', () => {
    expect(rowKey({ name: 'web', state: 'running' })).toBe(rowKey({ name: 'web', state: 'running' }));
    expect(rowKey({ name: 'web' })).not.toBe(rowKey({ name: 'db' }));
  });

  it('uses the first column of a table, or the row title of a list', () => {
    expect(rowLabel(table(), rows[0])).toBe('web');
    expect(rowLabel({ type: 'list', row: { title: '{name} ({state})', actions: [] } }, rows[0])).toBe('web (running)');
  });
});

describe('bulkCandidates', () => {
  it('keeps only actions the person may use, and only selected rows they apply to', () => {
    const candidates = bulkCandidates(table(), rows, all, actions, () => true);
    expect(candidates.map(c => c.action.id)).toEqual(['stop', 'start', 'remove']);
    expect(candidates.find(c => c.action.id === 'stop')!.rows.map(r => r.name)).toEqual(['web', 'db']);
    expect(candidates.find(c => c.action.id === 'start')!.rows.map(r => r.name)).toEqual(['old']);
    expect(candidates.find(c => c.action.id === 'remove')!.rows.map(r => r.name)).toEqual(['web', 'db', 'old']);
  });

  it('counts the selected rows an action does not apply to as skipped', () => {
    const stop = bulkCandidates(table(), rows, all, actions, () => true).find(c => c.action.id === 'stop')!;
    expect(stop.skipped).toBe(1);
    expect(bulkCandidates(table(), rows, all, actions, () => true).find(c => c.action.id === 'remove')!.skipped).toBe(0);
  });

  it('leaves out an action when the person may not use it or no selected row applies', () => {
    const allowed = (a: TestAction) => a.id !== 'remove';
    expect(bulkCandidates(table(), rows, all, actions, allowed).map(c => c.action.id)).toEqual(['stop', 'start']);
    expect(bulkCandidates(table(), rows, new Set([rowKey(rows[2])]), actions, () => true).map(c => c.action.id)).toEqual(['start', 'remove']);
    expect(bulkCandidates(table(), rows, new Set(), actions, () => true)).toEqual([]);
  });

  it('never offers a screen, terminal or parameterless action, even when a view names one', () => {
    const view = table({ rowActions: ['open', 'shell', 'prune', 'remove'], bulk: ['open', 'shell', 'prune', 'remove'] });
    expect(bulkCandidates(view, rows, all, actions, () => true).map(c => c.action.id)).toEqual(['remove']);
  });

  it('keeps the order the view gives, not the order of the selection', () => {
    const view = table({ bulk: ['remove', 'stop'] });
    expect(bulkCandidates(view, rows, all, actions, () => true).map(c => c.action.id)).toEqual(['remove', 'stop']);
  });
});

describe('selection helpers', () => {
  it('toggles one row and selects or clears the visible rows', () => {
    const one = toggleSelected(new Set(), rowKey(rows[0]), true);
    expect(selectedRows(rows, one).map(r => r.name)).toEqual(['web']);
    expect(selectedRows(rows, toggleSelected(one, rowKey(rows[0]), false))).toEqual([]);

    const allVisible = selectAll(one, rows, true);
    expect(selectedRows(rows, allVisible).map(r => r.name)).toEqual(['web', 'db', 'old']);
    expect(selectedRows(rows, selectAll(allVisible, rows.slice(0, 2), false)).map(r => r.name)).toEqual(['old']);
  });
});

describe('bulkNames', () => {
  it('lists the first ten and says how many are left', () => {
    const many = Array.from({ length: 13 }, (_, i) => ({ name: `row-${i}` }));
    const names = bulkNames(table(), many);
    expect(names.names).toHaveLength(10);
    expect(names.names[0]).toBe('row-0');
    expect(names.more).toBe(3);
    expect(bulkNames(table(), many.slice(0, 3))).toEqual({ names: ['row-0', 'row-1', 'row-2'], more: 0 });
  });
});
