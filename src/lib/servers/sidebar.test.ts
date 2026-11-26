import { describe, it, expect } from 'vitest';
import {
  offlineAgeText,
  parseServerTimestamp,
  serverHealth,
  serverStatusLabel,
  serverSubtitle,
  sortServersForSidebar,
  type SidebarServer,
} from './sidebar';

const server = (overrides: Partial<SidebarServer> & Pick<SidebarServer, 'id' | 'name'>): SidebarServer => ({
  hostname: `${overrides.id}.lan`,
  is_online: true,
  ...overrides,
});

describe('sidebar server health', () => {
  it('treats a paused poll as warning even when the host is online', () => {
    expect(serverHealth({ is_online: true })).toBe('online');
    expect(serverHealth({ is_online: false })).toBe('offline');
    expect(serverHealth({ is_online: true, poll_enabled: false })).toBe('paused');
    expect(serverHealth({ is_online: false, poll_enabled: false })).toBe('paused');
  });

  it('gives every state an accessible label', () => {
    expect(serverStatusLabel('online')).toBe('online');
    expect(serverStatusLabel('offline')).toBe('offline');
    expect(serverStatusLabel('paused')).toBe('monitoring paused');
  });
});

describe('sortServersForSidebar', () => {
  it('puts offline and paused servers first, then sorts by name', () => {
    const sorted = sortServersForSidebar([
      server({ id: '1', name: 'zeta', is_online: true }),
      server({ id: '2', name: 'beta', is_online: false }),
      server({ id: '3', name: 'Alpha', is_online: true, poll_enabled: false }),
      server({ id: '4', name: 'gamma', is_online: false }),
    ]);
    expect(sorted.map(s => s.name)).toEqual(['Alpha', 'beta', 'gamma', 'zeta']);
  });

  it('keeps a stable order for equal names and does not mutate the input', () => {
    const input = [
      server({ id: 'b', name: 'same' }),
      server({ id: 'a', name: 'Same' }),
      server({ id: 'c', name: 'aaa' }),
    ];
    const sorted = sortServersForSidebar(input);
    expect(sorted.map(s => s.id)).toEqual(['c', 'a', 'b']);
    expect(input.map(s => s.id)).toEqual(['b', 'a', 'c']);
  });
});

describe('offlineAgeText', () => {
  const now = Date.parse('2026-05-01T12:00:00Z');

  it('returns plain "offline" without a usable timestamp', () => {
    expect(offlineAgeText(null, now)).toBe('offline');
    expect(offlineAgeText('', now)).toBe('offline');
    expect(offlineAgeText('not a date', now)).toBe('offline');
  });

  it('formats minutes, hours and days', () => {
    expect(offlineAgeText('2026-05-01T11:59:30Z', now)).toBe('offline <1 min');
    expect(offlineAgeText('2026-05-01T11:56:00Z', now)).toBe('offline 4 min');
    expect(offlineAgeText('2026-05-01T11:01:01Z', now)).toBe('offline 58 min');
    expect(offlineAgeText('2026-05-01T10:00:00Z', now)).toBe('offline 2 h');
    expect(offlineAgeText('2026-04-28T12:00:00Z', now)).toBe('offline 3 d');
  });

  it('reads rqlite CURRENT_TIMESTAMP as UTC and clamps future times', () => {
    expect(offlineAgeText('2026-05-01 11:56:00', now)).toBe('offline 4 min');
    expect(parseServerTimestamp('2026-05-01 11:56:00')).toBe(Date.parse('2026-05-01T11:56:00Z'));
    expect(offlineAgeText('2026-05-01T12:05:00Z', now)).toBe('offline <1 min');
  });
});

describe('serverSubtitle', () => {
  const now = Date.parse('2026-05-01T12:00:00Z');

  it('shows the hostname while online', () => {
    expect(serverSubtitle({ hostname: ' 10.0.0.5 ', is_online: true, last_seen: null }, now)).toBe('10.0.0.5');
    expect(serverSubtitle({ hostname: null, is_online: true, last_seen: null }, now)).toBe('');
  });

  it('shows the offline age instead of a hostname', () => {
    expect(serverSubtitle({ hostname: '10.0.0.5', is_online: false, last_seen: '2026-05-01T11:56:00Z' }, now)).toBe('offline 4 min');
    expect(serverSubtitle({ hostname: '10.0.0.5', is_online: 0, last_seen: null }, now)).toBe('offline');
  });
});
