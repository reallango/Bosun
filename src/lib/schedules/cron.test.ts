import { describe, it, expect } from 'vitest';
import { cronFromPreset, cronProblem, missedRunDecision, nextRun, parseCron, presetFromCron, validateTimeZone } from './cron';

const at = (iso: string) => new Date(iso);
const iso = (d: Date | null) => d?.toISOString() ?? null;

describe('cron parsing', () => {
  it('reads *, numbers, lists, ranges and steps', () => {
    const r = parseCron('*/15 0-6 1,15 * 1-5');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.minutes).toEqual([0, 15, 30, 45]);
    expect(r.value.hours).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(r.value.days).toEqual([1, 15]);
    expect(r.value.weekdays).toEqual([1, 2, 3, 4, 5]);
    expect(r.value.domRestricted).toBe(true);
    expect(r.value.dowRestricted).toBe(true);
    expect(parseCron('5/10 * * * *')).toMatchObject({ ok: true, value: { minutes: [5, 15, 25, 35, 45, 55] } });
    expect(parseCron('0 0 * * 7')).toMatchObject({ ok: true, value: { weekdays: [0] } });
  });

  it('says why an expression is not valid', () => {
    expect(cronProblem('0 3 * *')).toContain('five fields');
    expect(cronProblem('60 * * * *')).toContain('outside 0-59');
    expect(cronProblem('*/0 * * * *')).toContain('step');
    expect(cronProblem('1-2-3 * * * *')).toContain('not a range');
    expect(cronProblem('? * * * *')).toContain('not a number');
    expect(cronProblem('0 24 * * *')).toContain('outside 0-23');
    expect(cronProblem('0 0 0 * *')).toContain('outside 1-31');
    expect(cronProblem('0 0 * 13 *')).toContain('outside 1-12');
  });

  it('knows the time zones Intl knows', () => {
    expect(validateTimeZone('Europe/Berlin')).toBe(true);
    expect(validateTimeZone('UTC')).toBe(true);
    expect(validateTimeZone('Mars/Olympus')).toBe(false);
    expect(validateTimeZone('')).toBe(false);
  });
});

describe('nextRun', () => {
  it('finds the next minute in UTC', () => {
    expect(iso(nextRun('0 3 * * *', 'UTC', at('2026-01-01T02:59:00Z')))).toBe('2026-01-01T03:00:00.000Z');
    expect(iso(nextRun('*/15 * * * *', 'UTC', at('2026-01-01T03:07:00Z')))).toBe('2026-01-01T03:15:00.000Z');
    expect(iso(nextRun('0 3 * * *', 'UTC', at('2026-01-01T03:00:00Z')))).toBe('2026-01-02T03:00:00.000Z');
  });

  it('evaluates the wall clock in the schedule time zone', () => {
    // 09:00 in Berlin in June is 07:00Z (CEST), in January 08:00Z (CET).
    expect(iso(nextRun('0 9 * * *', 'Europe/Berlin', at('2026-06-01T00:00:00Z')))).toBe('2026-06-01T07:00:00.000Z');
    expect(iso(nextRun('0 9 * * *', 'Europe/Berlin', at('2026-01-01T00:00:00Z')))).toBe('2026-01-01T08:00:00.000Z');
    expect(iso(nextRun('0 9 * * *', 'America/New_York', at('2026-01-01T00:00:00Z')))).toBe('2026-01-01T14:00:00.000Z');
  });

  it('skips a local time that DST removes', () => {
    // Berlin jumps from 02:00 to 03:00 on 2026-03-29, so 02:30 does not exist that day.
    expect(iso(nextRun('30 2 * * *', 'Europe/Berlin', at('2026-03-29T00:00:00Z')))).toBe('2026-03-30T00:30:00.000Z');
  });

  it('runs at both instants of a local time DST repeats', () => {
    // Berlin repeats 02:00-03:00 on 2026-10-25: 02:30 is 00:30Z (CEST) and again 01:30Z (CET).
    expect(iso(nextRun('30 2 * * *', 'Europe/Berlin', at('2026-10-25T00:00:00Z')))).toBe('2026-10-25T00:30:00.000Z');
    expect(iso(nextRun('30 2 * * *', 'Europe/Berlin', at('2026-10-25T00:30:00Z')))).toBe('2026-10-25T01:30:00.000Z');
    expect(iso(nextRun('30 2 * * *', 'Europe/Berlin', at('2026-10-25T01:30:00Z')))).toBe('2026-10-26T01:30:00.000Z');
  });

  it('honours day-of-week and the either/or rule with day-of-month', () => {
    // 2026-01-01 is a Thursday.
    expect(iso(nextRun('0 12 * * 1', 'UTC', at('2026-01-01T00:00:00Z')))).toBe('2026-01-05T12:00:00.000Z');
    // Day 1 OR Monday: the next Monday is 5 January, before 1 February.
    expect(iso(nextRun('0 0 1 * 1', 'UTC', at('2026-01-02T00:00:00Z')))).toBe('2026-01-05T00:00:00.000Z');
  });

  it('returns null when nothing runs, or the inputs are bad', () => {
    expect(nextRun('0 0 31 2 *', 'UTC', at('2026-01-01T00:00:00Z'))).toBeNull();
    expect(nextRun('0 0 * * *', 'Mars/Olympus', at('2026-01-01T00:00:00Z'))).toBeNull();
    expect(nextRun('nope', 'UTC', at('2026-01-01T00:00:00Z'))).toBeNull();
  });
});

describe('presets and missed runs', () => {
  it('round-trips the presets the dialog offers', () => {
    expect(cronFromPreset({ kind: 'hourly' })).toBe('0 * * * *');
    expect(cronFromPreset({ kind: 'daily', hour: 3, minute: 5 })).toBe('5 3 * * *');
    expect(cronFromPreset({ kind: 'weekly', weekday: 1, hour: 3, minute: 5 })).toBe('5 3 * * 1');
    expect(presetFromCron('0 * * * *')).toEqual({ kind: 'hourly' });
    expect(presetFromCron('5 3 * * *')).toEqual({ kind: 'daily', hour: 3, minute: 5 });
    expect(presetFromCron('5 3 * * 1')).toEqual({ kind: 'weekly', weekday: 1, hour: 3, minute: 5 });
    expect(presetFromCron('*/5 * * * *')).toBeNull();
  });

  it('runs a late occurrence only when it is less than one interval late', () => {
    const due = at('2026-01-01T03:00:00Z');
    expect(missedRunDecision(due, at('2026-01-01T03:30:00Z'), 3_600_000)).toBe('run');
    expect(missedRunDecision(due, at('2026-01-01T04:00:00Z'), 3_600_000)).toBe('skip');
    expect(missedRunDecision(due, at('2026-01-02T03:00:00Z'), 0)).toBe('run');
  });
});
