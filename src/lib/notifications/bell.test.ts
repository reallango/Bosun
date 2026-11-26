import { describe, it, expect } from 'vitest';
import { groupBell, notificationTime, type BellNotification, type BellTask } from './bell';

const NOW = Date.parse('2026-11-26T12:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW - h * 3600_000).toISOString();
const msAgo = (m: number) => NOW - m * 60_000;

function note(id: string, overrides: Partial<BellNotification> = {}): BellNotification {
  return {
    id, kind: 'alert', type: 'info', title: id, message: '', read: false,
    created_at: hoursAgo(1), ...overrides,
  };
}

function task(id: string, overrides: Partial<BellTask> = {}): BellTask {
  return {
    id, status: 'success', actionLabel: id, serverName: 's1', message: null, steps: [],
    percent: null, startedAt: msAgo(120), finishedAt: msAgo(60), ...overrides,
  };
}

const ids = (items: { type: string; notification?: { id: string }; task?: { id: string } }[]) =>
  items.map(i => (i.type === 'notification' ? `n:${i.notification!.id}` : `t:${i.task!.id}`));

describe('groupBell', () => {
  it('reads SQLite timestamps as UTC', () => {
    expect(notificationTime('2026-11-26 12:00:00')).toBe(Date.parse('2026-11-26T12:00:00Z'));
  });

  it('puts decisions first, keeps failed tasks out of New, and merges the rest newest first', () => {
    const notifications = [
      note('n-unread', { created_at: hoursAgo(1) }),
      note('n-read', { read: true, created_at: hoursAgo(2) }),
      note('n-old-read', { read: true, created_at: hoursAgo(25) }),
      note('n-request', { kind: 'access_request', request_id: 'r1', created_at: hoursAgo(3) }),
    ];
    const tasks = [
      task('t-running', { status: 'running', finishedAt: null, startedAt: msAgo(10) }),
      task('t-failed', { status: 'error', finishedAt: msAgo(10) }),
      task('t-success', { status: 'success', finishedAt: msAgo(5) }),
      task('t-seen', { status: 'success', finishedAt: msAgo(240) }),
      task('t-seen-old', { status: 'success', finishedAt: msAgo(25 * 60) }),
      task('t-dismissed', { status: 'success', dismissed: true, finishedAt: msAgo(1) }),
      task('t-failed-seen', { status: 'error', finishedAt: msAgo(60) }),
      task('t-unseen-old', { status: 'cancelled', finishedAt: msAgo(25 * 60) }),
    ];
    const seen = new Set(['t-seen', 't-seen-old', 't-failed-seen']);

    const groups = groupBell({ notifications, tasks, seen, now: NOW });

    expect(ids(groups.attention)).toEqual(['n:n-request', 't:t-failed']);
    expect(ids(groups.running)).toEqual(['t:t-running']);
    expect(ids(groups.newItems)).toEqual(['t:t-success', 'n:n-unread', 't:t-unseen-old']);
    expect(ids(groups.earlier)).toEqual(['t:t-failed-seen', 'n:n-read', 't:t-seen']);
    expect(groups.counts).toMatchObject({
      unread: 2,
      unseen: 3,
      failedUnseen: 1,
      attention: 2,
      running: 1,
      badge: 3,
    });
  });

  it('keeps dismissed items out of every section', () => {
    const groups = groupBell({
      notifications: [note('n-dismissed', { dismissed: true }), note('n-kept')],
      tasks: [task('t-dismissed', { dismissed: true }), task('t-kept')],
      seen: new Set(),
      now: NOW,
    });
    expect(ids(groups.newItems)).toEqual(['n:n-kept', 't:t-kept']);
    expect(groups.attention).toEqual([]);
    expect(groups.earlier).toEqual([]);
  });

  it('shows at most ten read or seen items from the last 24 hours, newest first', () => {
    const notifications = Array.from({ length: 15 }, (_, i) =>
      note(`n${i}`, { read: true, created_at: hoursAgo(i + 1) }));
    const groups = groupBell({ notifications, tasks: [], seen: new Set(), now: NOW });
    expect(groups.earlier).toHaveLength(10);
    expect(ids(groups.earlier)).toEqual(Array.from({ length: 10 }, (_, i) => `n:n${i}`));
  });
});
