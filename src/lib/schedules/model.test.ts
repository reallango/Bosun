import { describe, it, expect } from 'vitest';
import { actionParams, countMatching, datasetArgs, noticeFor, pauseKey, planDueRun, rowsOf } from './model';
import type { ScheduleSpec } from '@/lib/widgets/runtime/spec-schedules';

const kind = (over: Partial<ScheduleSpec> = {}): ScheduleSpec => ({
  id: 'check', label: 'Check', run: { dataset: 'findings' }, options: { args: { all: true } }, ...over,
});

describe('what a dataset answer becomes', () => {
  it('finds the rows in the shapes a dataset can return', () => {
    expect(rowsOf([1, 2])).toEqual([1, 2]);
    expect(rowsOf({ rows: [1] })).toEqual([1]);
    expect(rowsOf({ items: [2] })).toEqual([2]);
    expect(rowsOf({ data: [3] })).toEqual([3]);

    expect(rowsOf(null)).toEqual([]);
    expect(rowsOf({ nope: 1 })).toEqual([]);
  });

  it('counts every row without a condition, and only matches with one', () => {
    const rows = [{ available: true }, { available: false }, { available: true }];
    expect(countMatching(rows, undefined)).toBe(3);
    expect(countMatching(rows, { field: 'available', equals: true })).toBe(2);
    expect(countMatching(rows, { all: [{ field: 'available', equals: true }] })).toBe(2);
  });
});

describe('the one notice a dataset run raises', () => {
  it('fills count, server and schedule and dedupes per schedule per day', () => {
    const n = noticeFor(
      { id: 's1', name: 'Nightly' },
      { title: '{count} update(s) on {server}', message: 'Schedule {schedule} found {count} on {server}.', severity: 'warning' },
      3, 'alpha', new Date('2026-01-02T10:00:00Z'),
    );
    expect(n).toEqual({
      title: '3 update(s) on alpha',
      message: 'Schedule Nightly found 3 on alpha.',
      severity: 'warning',
      dedupeKey: 'schedule-notice:s1:2026-01-02',
    });
    expect(noticeFor({ id: 's1', name: 'Nightly' }, { title: 't', message: 'm' }, 1, 'alpha', new Date('2026-01-02T23:59:00Z')).dedupeKey)
      .toBe('schedule-notice:s1:2026-01-02');
    expect(noticeFor({ id: 's1', name: 'Nightly' }, { title: 't', message: 'm' }, 1, 'alpha', new Date('2026-01-03T00:00:00Z')).dedupeKey)
      .toBe('schedule-notice:s1:2026-01-03');
    expect(noticeFor({ id: 's1', name: 'Nightly' }, { title: 't', message: 'm' }, 1, 'alpha', new Date()).severity).toBe('info');
  });

  it('dedupes a pause notice per schedule, day and reason', () => {
    const a = pauseKey('s1', 'gone', new Date('2026-01-02T10:00:00Z'));
    expect(a).toBe(pauseKey('s1', 'gone', new Date('2026-01-02T18:00:00Z')));
    expect(a).not.toBe(pauseKey('s1', 'other', new Date('2026-01-02T10:00:00Z')));
    expect(a).not.toBe(pauseKey('s1', 'gone', new Date('2026-01-03T10:00:00Z')));
  });
});

describe('the claim plan', () => {
  it('advances to the next run and flags a missed interval', () => {
    const plan = planDueRun('0 * * * *', 'UTC', '2026-01-01T10:00:00.000Z', new Date('2026-01-01T10:30:00Z'));
    expect(plan).toMatchObject({ nextAt: '2026-01-01T11:00:00.000Z', missed: false, intervalMs: 3_600_000 });
    const late = planDueRun('0 * * * *', 'UTC', '2026-01-01T10:00:00.000Z', new Date('2026-01-01T11:30:00Z'));
    expect(late).toMatchObject({ nextAt: '2026-01-01T12:00:00.000Z', missed: true });
  });

  it('gives no plan for a broken timetable', () => {
    expect(planDueRun('nope', 'UTC', '2026-01-01T10:00:00.000Z', new Date())).toBeNull();
    expect(planDueRun('0 * * * *', 'UTC', 'not a date', new Date())).toBeNull();
  });
});

describe('arguments a run sends', () => {
  it('merges the kind defaults, the stored values and the target', () => {
    expect(datasetArgs(kind(), { args: { all: false } }, 'web', 'name')).toEqual({ all: false, name: 'web' });
    expect(datasetArgs(kind({ options: undefined }), {}, null, null)).toEqual({});
  });

  it('merges action parameters the same way', () => {
    const actionKind: ScheduleSpec = { id: 'a', label: 'A', run: { action: 'restart', params: { name: 'web' } } };
    expect(actionParams(actionKind, { params: { name: 'api' } }, 'web', 'name')).toEqual({ name: 'web' });
    expect(actionParams(actionKind, { params: { name: 'api' } }, null, null)).toEqual({ name: 'api' });
  });
});
