import { describe, it, expect } from 'vitest';
import { matchScore, searchPalette, type PaletteItem } from './palette';

const items: PaletteItem[] = [
  { id: 'd1', kind: 'dashboard', label: 'Home', href: '/' },
  { id: 'd2', kind: 'dashboard', label: 'Infrastructure', href: '/dashboards/d2' },
  { id: 's1', kind: 'server', label: 'web-01', detail: '10.0.0.5', href: '/servers/s1' },
  { id: 's2', kind: 'server', label: 'db-01', detail: '10.0.0.6', href: '/servers/s2' },
  { id: 'set1', kind: 'settings', label: 'SSH keys', detail: 'Settings · You', href: '/settings/ssh-keys', keywords: ['You', 'settings'] },
  { id: 'sc1', kind: 'screen', label: 'Docker on web-01', detail: 'Widget page', href: '/widgets/w1/manage', keywords: ['Docker', 'web-01'] },
];

const ids = (list: PaletteItem[]) => list.map(i => i.id);

describe('matchScore', () => {
  it('matches case-insensitively and as a subsequence', () => {
    expect(matchScore('HOME', items[0])).not.toBeNull();
    expect(matchScore('hme', items[0])).not.toBeNull();
    expect(matchScore('hme', items[0])!).toBeGreaterThan(0);
  });

  it('requires every word to match, but words may match different fields', () => {
    expect(matchScore('web docker', items[5])).not.toBeNull();
    expect(matchScore('settings you', items[4])).not.toBeNull();
    expect(matchScore('settings web', items[4])).toBeNull();
  });

  it('returns null when a letter is missing or out of order', () => {
    expect(matchScore('xyz', items[0])).toBeNull();
    expect(matchScore('emoh', items[0])).toBeNull();
  });

  it('prefers a match at the start of a label', () => {
    expect(matchScore('web', items[2])!).toBeGreaterThan(matchScore('web', items[5])!);
  });
});

describe('searchPalette', () => {
  it('keeps the caller order for an empty query and honours the limit', () => {
    expect(ids(searchPalette(items, ''))).toEqual(ids(items));
    expect(ids(searchPalette(items, '  ', 2))).toEqual(['d1', 'd2']);
  });

  it('finds labels, details and keywords', () => {
    expect(ids(searchPalette(items, 'infra'))).toEqual(['d2']);
    expect(ids(searchPalette(items, '10.0.0.6'))).toEqual(['s2']);
    expect(ids(searchPalette(items, 'ssh'))).toEqual(['set1']);
  });

  it('ranks the label match first and breaks ties by kind', () => {
    expect(ids(searchPalette(items, 'web'))).toEqual(['s1', 'sc1']);
    const tied: PaletteItem[] = [
      { id: 'screen', kind: 'screen', label: 'web', href: '/w' },
      { id: 'server', kind: 'server', label: 'web', href: '/s' },
      { id: 'dashboard', kind: 'dashboard', label: 'web', href: '/d' },
    ];
    expect(ids(searchPalette(tied, 'web'))).toEqual(['dashboard', 'server', 'screen']);
  });

  it('returns nothing for a query no item matches', () => {
    expect(searchPalette(items, 'zzz')).toEqual([]);
  });

  it('does not match the same item twice when several fields match', () => {
    const found = searchPalette(items, 'docker');
    expect(found).toHaveLength(1);
    expect(found[0].id).toBe('sc1');
  });
});
