/**
 * Five-field cron expressions evaluated in an IANA time zone.
 *
 * Fields: minute hour day-of-month month day-of-week. Each field accepts `*`, a number, a range (`1-5`),
 * a list (`1,15,30`) and a step (`* /15`, `0-30/10`, `5/10`). Day-of-week is 0-6 with Sunday as 0 (7 is
 * accepted as Sunday too). When both day-of-month and day-of-week are restricted, a day matches either
 * of them, as in traditional cron.
 *
 * Time zones come from `Intl`, so there is no dependency and the host's tz database decides DST. A local
 * time that does not exist (the hour skipped when clocks move forward) has no run; a local time that
 * happens twice (clocks move back) runs at both instants, so `nextRun` returns the earliest one after
 * the given moment.
 *
 * Pure (no I/O), so the engine, the API and the tests share it.
 */

export interface CronFields {
  minutes: number[];
  hours: number[];
  days: number[];
  months: number[];
  weekdays: number[];
  /** The day-of-month field is not `*`, so it takes part in the either/or rule with day-of-week. */
  domRestricted: boolean;
  dowRestricted: boolean;
}

export type CronResult = { ok: true; value: CronFields } | { ok: false; error: string };

interface Range { min: number; max: number; label: string; normalize?: (n: number) => number }

const RANGES: Record<string, Range> = {
  minute: { min: 0, max: 59, label: 'minute' },
  hour: { min: 0, max: 23, label: 'hour' },
  day: { min: 1, max: 31, label: 'day-of-month' },
  month: { min: 1, max: 12, label: 'month' },
  weekday: { min: 0, max: 7, label: 'day-of-week', normalize: n => (n === 7 ? 0 : n) },
};

function parseField(raw: string, range: Range): { ok: true; value: number[] } | { ok: false; error: string } {
  if (raw === '') return { ok: false, error: `the ${range.label} field is empty` };
  const out = new Set<number>();
  for (const part of raw.split(',')) {
    if (!part) return { ok: false, error: `the ${range.label} field has an empty item` };
    const [base, stepText, extra] = part.split('/');
    if (extra !== undefined) return { ok: false, error: `"${part}" has more than one step` };
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) return { ok: false, error: `"${part}" needs a whole step of at least 1` };
    let from: number;
    let to: number;
    if (base === '*') {
      from = range.min;
      to = range.max;
    } else if (base.includes('-')) {
      const [a, b, rest] = base.split('-');
      if (rest !== undefined || a === '' || b === '') return { ok: false, error: `"${part}" is not a range` };
      from = Number(a);
      to = Number(b);
    } else {
      from = Number(base);
      to = stepText === undefined ? from : range.max;
    }
    if (!Number.isInteger(from) || !Number.isInteger(to)) return { ok: false, error: `"${part}" is not a number or range` };
    if (from < range.min || to > range.max || from > to) {
      return { ok: false, error: `"${part}" is outside ${range.min}-${range.max} for ${range.label}` };
    }
    for (let n = from; n <= to; n += step) out.add(range.normalize ? range.normalize(n) : n);
  }
  return { ok: true, value: Array.from(out).sort((a, b) => a - b) };
}

/** Parse a five-field cron expression. */
export function parseCron(expr: string): CronResult {
  if (typeof expr !== 'string') return { ok: false, error: 'the cron expression must be text' };
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return { ok: false, error: 'a cron expression has five fields: minute hour day-of-month month day-of-week' };
  const [minute, hour, day, month, weekday] = fields;
  const parsed = [
    parseField(minute, RANGES.minute),
    parseField(hour, RANGES.hour),
    parseField(day, RANGES.day),
    parseField(month, RANGES.month),
    parseField(weekday, RANGES.weekday),
  ];
  for (const p of parsed) if (!p.ok) return p;
  return {
    ok: true,
    value: {
      minutes: (parsed[0] as { value: number[] }).value,
      hours: (parsed[1] as { value: number[] }).value,
      days: (parsed[2] as { value: number[] }).value,
      months: (parsed[3] as { value: number[] }).value,
      weekdays: (parsed[4] as { value: number[] }).value,
      domRestricted: day !== '*',
      dowRestricted: weekday !== '*',
    },
  };
}

/** Why `expr` is not a valid five-field cron expression, or null when it is. */
export function cronProblem(expr: string): string | null {
  const r = parseCron(expr);
  return r.ok ? null : r.error;
}

/** Is `tz` an IANA time zone this runtime knows? */
export function validateTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

interface LocalParts { y: number; m: number; d: number; h: number; min: number; s: number }

function localParts(instantMs: number, tz: string): LocalParts {
  const parts = formatter(tz).formatToParts(new Date(instantMs));
  const get = (type: string) => Number(parts.find(p => p.type === type)?.value);
  return { y: get('year'), m: get('month'), d: get('day'), h: get('hour'), min: get('minute'), s: get('second') };
}

function localAsUtc(instantMs: number, tz: string): number {
  const p = localParts(instantMs, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s);
}

/** The zone's offset from UTC at an instant, in milliseconds (local = UTC + offset). */
function offsetAt(instantMs: number, tz: string): number {
  return localAsUtc(instantMs, tz) - Math.floor(instantMs / 1000) * 1000;
}

/**
 * The instants whose wall-clock time in `tz` is `localMs` (a Date.UTC value): none in a DST gap, two in an
 * ambiguous hour, normally one.
 */
function zonedCandidates(localMs: number, tz: string): number[] {
  const first = offsetAt(localMs, tz);
  const guess = localMs - first;
  const offsets = new Set([first, offsetAt(guess, tz), offsetAt(guess - 3_600_000, tz), offsetAt(guess + 3_600_000, tz)]);
  const out = new Set<number>();
  for (const offset of Array.from(offsets)) {
    const candidate = localMs - offset;
    if (localAsUtc(candidate, tz) === localMs) out.add(candidate);
  }
  return Array.from(out).sort((a, b) => a - b);
}

function dayMatches(f: CronFields, y: number, m: number, d: number): boolean {
  if (!f.months.includes(m)) return false;
  const domOk = f.days.includes(d);
  const dowOk = f.weekdays.includes(new Date(Date.UTC(y, m - 1, d)).getUTCDay());
  return f.domRestricted && f.dowRestricted ? domOk || dowOk : domOk && dowOk;
}

export interface NextRunOptions {
  /** How many local days to look ahead (default 366). */
  maxDays?: number;
}

/** The first instant after `after` at which the expression runs, or null when there is none in the window. */
export function nextRun(cron: string, tz: string, after: Date, opts: NextRunOptions = {}): Date | null {
  const parsed = parseCron(cron);
  if (!parsed.ok || !validateTimeZone(tz) || Number.isNaN(after.getTime())) return null;
  const f = parsed.value;
  const afterMs = after.getTime();
  const start = localParts(afterMs, tz);
  const maxDays = opts.maxDays ?? 366;
  for (let i = 0; i < maxDays; i++) {
    const day = new Date(Date.UTC(start.y, start.m - 1, start.d + i));
    const y = day.getUTCFullYear();
    const m = day.getUTCMonth() + 1;
    const d = day.getUTCDate();
    if (!dayMatches(f, y, m, d)) continue;
    for (const h of f.hours) {
      for (const min of f.minutes) {
        const localMs = Date.UTC(y, m - 1, d, h, min, 0);
        for (const candidate of zonedCandidates(localMs, tz)) {
          if (candidate > afterMs) return new Date(candidate);
        }
      }
    }
  }
  return null;
}

/** How long the gap after `at` is: the next run's time minus `at` (null when nothing follows). */
export function intervalAfter(cron: string, tz: string, at: Date): number | null {
  const next = nextRun(cron, tz, at);
  return next ? next.getTime() - at.getTime() : null;
}

/**
 * A due run that is at least one whole interval late (the cluster was down) is recorded as skipped instead of
 * running, so a schedule that was off for hours does not run a burst at the next tick.
 */
export function missedRunDecision(dueAt: Date, now: Date, intervalMs: number): 'run' | 'skip' {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return 'run';
  return now.getTime() - dueAt.getTime() < intervalMs ? 'run' : 'skip';
}

export type CronPreset =
  | { kind: 'hourly' }
  | { kind: 'daily'; hour: number; minute: number }
  | { kind: 'weekly'; weekday: number; hour: number; minute: number };

function clock(hour: number, minute: number): string | null {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  return `${minute} ${hour}`;
}

/** The cron expression a UI preset stands for (null for a preset with an impossible time). */
export function cronFromPreset(preset: CronPreset): string | null {
  if (preset.kind === 'hourly') return '0 * * * *';
  const time = clock(preset.hour, preset.minute);
  if (!time) return null;
  if (preset.kind === 'daily') return `${time} * * *`;
  const day = preset.weekday === 7 ? 0 : preset.weekday;
  if (!Number.isInteger(day) || day < 0 || day > 6) return null;
  return `${time} * * ${day}`;
}

/** The preset a cron expression is, when it is one of the simple shapes the UI offers (otherwise null). */
export function presetFromCron(cron: string): CronPreset | null {
  const parsed = parseCron(cron);
  if (!parsed.ok) return null;
  const f = parsed.value;
  if (f.minutes.length !== 1) return null;
  const minute = f.minutes[0];
  if (!f.domRestricted && !f.dowRestricted && f.days.length === 31 && f.months.length === 12) {
    if (f.hours.length === 24) return { kind: 'hourly' };
    if (f.hours.length === 1) return { kind: 'daily', hour: f.hours[0], minute };
  }
  if (!f.domRestricted && f.dowRestricted && f.hours.length === 1 && f.weekdays.length === 1 && f.months.length === 12) {
    return { kind: 'weekly', weekday: f.weekdays[0], hour: f.hours[0], minute };
  }
  return null;
}
