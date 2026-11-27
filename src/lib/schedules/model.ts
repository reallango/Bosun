/**
 * Shared shapes and pure helpers of the schedule engine: the stored options, the claim plan, the notice text and
 * how a dataset's answer becomes rows. No I/O, so the engine, the API and the tests share them.
 */
import { evalCond, fillTemplate } from '@/lib/widgets/runtime/spec';
import type { ActionSpec, Cond, ParamSpec } from '@/lib/widgets/runtime/spec';
import type { DatasetSpec } from '@/lib/widgets/runtime/spec-screens';
import type { LoadedSpec } from '@/lib/widgets/runtime/execute';
import type { ScheduleNotify, ScheduleSpec } from '@/lib/widgets/runtime/spec-schedules';
import { intervalAfter, missedRunDecision, nextRun } from './cron';

export type ScheduleArg = string | number | boolean;

/** What a schedule stores in `options` (JSON): the fixed arguments of its run and its history size. */
export interface StoredOptions {
  /** Dataset arguments (the target fills its own). */
  args?: Record<string, ScheduleArg>;
  /** Action parameters (merged over the kind's own; the target fills its own). */
  params?: Record<string, ScheduleArg>;
  keepRuns?: number;
}

export interface ScheduleRow {
  id: string;
  name: string;
  widget_type: string;
  schedule_kind: string;
  server_id: string;
  resource_kind: string;
  resource_name: string;
  cron: string;
  timezone: string;
  enabled: number;
  options: string;
  created_by_type: 'user' | 'api_key';
  created_by_id: string;
  created_by_name: string;
  created_at: string;
  updated_at: string;
  last_run_at: string | null;
  next_run_at: string | null;
  paused_reason: string | null;
}

export interface ScheduleRunRow {
  id: string;
  schedule_id: string;
  started_at: string;
  finished_at: string | null;
  status: 'running' | 'success' | 'failed' | 'skipped';
  message: string | null;
  job_id: string | null;
  matched_count: number | null;
}

export interface ScheduleRunDto {
  id: string;
  started_at: string;
  finished_at: string | null;
  status: ScheduleRunRow['status'];
  message: string | null;
  job_id: string | null;
  matched_count: number | null;
}

export interface ScheduleDto {
  id: string;
  name: string;
  widget_type: string;
  schedule_kind: string;
  kind_label: string;
  server_id: string;
  server_name: string | null;
  resource: { kind: 'stack' | 'container'; name: string } | null;
  cron: string;
  timezone: string;
  enabled: boolean;
  options: StoredOptions;
  created_by: { type: 'user' | 'api_key'; id: string; name: string };
  created_at: string;
  updated_at: string;
  last_run_at: string | null;
  next_run_at: string | null;
  paused_reason: string | null;
  last_run: ScheduleRunDto | null;
}

export function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || !raw) return fallback;
  try {
    const v = JSON.parse(raw) as T;
    return v && typeof v === 'object' ? v : fallback;
  } catch {
    return fallback;
  }
}

export function parseOptions(raw: unknown): StoredOptions {
  const o = parseJson<StoredOptions>(raw, {});
  const out: StoredOptions = {};
  if (o.args && typeof o.args === 'object' && !Array.isArray(o.args)) out.args = o.args;
  if (o.params && typeof o.params === 'object' && !Array.isArray(o.params)) out.params = o.params;
  if (Number.isInteger(o.keepRuns) && Number(o.keepRuns) >= 10 && Number(o.keepRuns) <= 1000) out.keepRuns = Number(o.keepRuns);
  return out;
}

export interface RunKindInfo {
  permission: string;
  params: Record<string, ParamSpec>;
  targetParam: string | null;
  targetKind: 'stack' | 'container' | null;
  dataset: DatasetSpec | null;
  action: ActionSpec | null;
}

/** What a declared kind runs: its permission, its script/action parameters and its target. Null when it vanished. */
export function describeRun(loaded: LoadedSpec, kind: ScheduleSpec): RunKindInfo | null {
  const declared = kind.run;
  if ('dataset' in declared) {
    const ds = loaded.spec.datasets?.[declared.dataset];
    if (!ds) return null;
    return {
      permission: ds.permission,
      params: loaded.spec.scripts?.[ds.script]?.params ?? {},
      targetParam: ds.target?.param ?? null,
      targetKind: ds.target?.kind ?? null,
      dataset: ds,
      action: null,
    };
  }
  const action = loaded.spec.actions.find(a => a.id === declared.action);
  if (!action) return null;
  return { permission: action.permission, params: action.params, targetParam: action.target?.param ?? null, targetKind: action.target?.kind ?? null, dataset: null, action };
}

/** The values a dataset run loads with: the stored arguments plus the target's name. */
export function datasetArgs(kind: ScheduleSpec, stored: StoredOptions, resourceName: string | null, targetParam: string | null): Record<string, ScheduleArg> {
  const out: Record<string, ScheduleArg> = { ...(kind.options?.args ?? {}), ...(stored.args ?? {}) };
  if (resourceName && targetParam) out[targetParam] = resourceName;
  return out;
}

/** The parameters an action run calls with: the kind's own, then the stored ones, then the target's name. */
export function actionParams(kind: ScheduleSpec, stored: StoredOptions, resourceName: string | null, targetParam: string | null): Record<string, ScheduleArg> {
  const out: Record<string, ScheduleArg> = { ...('action' in kind.run ? kind.run.params ?? {} : {}), ...(stored.params ?? {}) };
  if (resourceName && targetParam) out[targetParam] = resourceName;
  return out;
}

export interface DuePlan {
  /** When the following run is due (the value the claim writes). */
  nextAt: string;
  lateMs: number;
  intervalMs: number;
  /** The cluster was down for at least one interval: record a skipped run instead of running now. */
  missed: boolean;
}

/** What to do with a schedule whose `next_run_at` has passed. Null when its cron or time zone is unusable. */
export function planDueRun(cron: string, tz: string, dueIso: string, now: Date): DuePlan | null {
  const due = new Date(dueIso);
  if (Number.isNaN(due.getTime())) return null;
  const next = nextRun(cron, tz, now);
  if (!next) return null;
  const interval = intervalAfter(cron, tz, due);
  const lateMs = now.getTime() - due.getTime();
  const missed = missedRunDecision(due, now, interval ?? 0) === 'skip';
  return { nextAt: next.toISOString(), lateMs, intervalMs: interval ?? 0, missed };
}

/** The rows of a dataset answer: a list, or the first list at `rows`, `items` or `data`. */
export function rowsOf(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    const o = data as Record<string, unknown>;
    for (const key of ['rows', 'items', 'data']) if (Array.isArray(o[key])) return o[key] as unknown[];
  }
  return [];
}

/** How many rows satisfy `when` (every row when it is absent). */
export function countMatching(rows: unknown[], when: Cond | undefined): number {
  return when ? rows.filter(row => evalCond(when, row)).length : rows.length;
}

export interface ScheduleNotice {
  title: string;
  message: string;
  severity: 'info' | 'warning';
  dedupeKey: string;
}

/** Fill `{count}`, `{server}` and `{schedule}` in a notice template. */
export function fillNotice(template: string, vars: { count: number; server: string; schedule: string }): string {
  return fillTemplate(template, vars);
}

/** The one bell notice a dataset run raises (deduped per schedule per UTC day). */
export function noticeFor(schedule: { id: string; name: string }, notify: ScheduleNotify, count: number, serverName: string, at: Date): ScheduleNotice {
  const vars = { count, server: serverName, schedule: schedule.name };
  return {
    title: fillNotice(notify.title, vars).slice(0, 200),
    message: fillNotice(notify.message, vars).slice(0, 2000),
    severity: notify.severity ?? 'info',
    dedupeKey: `schedule-notice:${schedule.id}:${at.toISOString().slice(0, 10)}`,
  };
}

/** The dedupe key of a pause notice, so one pause does not fill the bell every tick. */
export function pauseKey(scheduleId: string, reason: string, at: Date): string {
  return `schedule-paused:${scheduleId}:${at.toISOString().slice(0, 10)}:${reason.slice(0, 60)}`;
}
