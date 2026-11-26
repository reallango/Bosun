import { describe, it, expect } from 'vitest';
import { compareForSort, nextSortDir, sortRows } from './sort';

describe('compareForSort', () => {
  it('compares numbers numerically, not as text', () => {
    expect(compareForSort(2, 10)).toBeLessThan(0);
    expect(compareForSort(10, 2)).toBeGreaterThan(0);
    expect(compareForSort(4, 4)).toBe(0);
  });

  it('compares anything else as case-insensitive text', () => {
    expect(compareForSort('apple', 'Banana')).toBeLessThan(0);
    expect(compareForSort('Banana', 'apple')).toBeGreaterThan(0);
    expect(compareForSort('Same', 'same')).toBe(0);
  });

  it('orders ISO dates chronologically as text', () => {
    const dates = ['2025-03-02T10:00:00Z', '2024-12-31T23:59:59Z', '2025-03-02T09:00:00Z'];
    expect(dates.slice().sort(compareForSort)).toEqual(['2024-12-31T23:59:59Z', '2025-03-02T09:00:00Z', '2025-03-02T10:00:00Z']);
  });

  it('treats a missing value as an empty string', () => {
    expect(compareForSort(undefined, 'a')).toBeLessThan(0);
    expect(compareForSort(null, 'a')).toBeLessThan(0);
    expect(compareForSort(undefined, null)).toBe(0);
  });
});

describe('sortRows', () => {
  const rows = [
    { name: 'nginx', size_bytes: 187000000 },
    { name: 'postgres', size_bytes: 432000000 },
    { name: 'none', size_bytes: 1100000000 },
  ];

  it('orders a copy by a raw field, ascending and descending', () => {
    expect(sortRows(rows, 'size_bytes', 'asc').map(r => r.name)).toEqual(['nginx', 'postgres', 'none']);
    expect(sortRows(rows, 'size_bytes', 'desc').map(r => r.name)).toEqual(['none', 'postgres', 'nginx']);
    expect(rows.map(r => r.name)).toEqual(['nginx', 'postgres', 'none']);
  });

  it('reads a dotted path into the row', () => {
    const nested = [{ meta: { order: 2 } }, { meta: { order: 1 } }];
    expect(sortRows(nested, 'meta.order', 'asc')).toEqual([nested[1], nested[0]]);
  });
});

describe('nextSortDir', () => {
  it('starts a fresh column ascending and flips the current one', () => {
    expect(nextSortDir(null)).toBe('asc');
    expect(nextSortDir('asc')).toBe('desc');
    expect(nextSortDir('desc')).toBe('asc');
  });
});
