/**
 * Schedules a widget package declares: the runs core may offer under Settings → Schedules.
 *
 * A schedule kind says what runs and how it may be aimed:
 *
 *   { "id": "check_updates", "label": "Check for updates", "run": { "dataset": "findings" },
 *     "target": "server", "notify": { "when": { "field": "available", "equals": true }, "title": "…" } }
 *
 * `run` is one of `{ dataset }` (read-only; core counts the rows and raises one notice) or `{ action, params? }`
 * (a runnable action, run as an ordinary job). `target` says whether the schedule is for the whole server or for
 * one stack/container the run declares as its target. Core never knows what a package does; it only runs these.
 *
 * Pure (no I/O).
 */
import type { ActionSpec, Cond, ParamSpec } from './spec';
import { cond, fail, ID_RE, intIn, isObj, scalar, text, type Validated } from './spec-util';
import type { DatasetSpec } from './spec-screens';
import type { ScriptSpec } from './spec-v2';
import { validateParamValues } from './script-run';
import { fixedTargetKind, targetKindParam } from './resources';

/**
 * `server` runs for the whole server; `stack`/`container` for one of that kind; `byKind` for one container or stack,
 * whose kind the schedule stores (the run declares `target.byKind`).
 */
export type ScheduleTarget = 'server' | 'stack' | 'container' | 'byKind';
export type ScheduleArg = string | number | boolean;

export interface ScheduleOptions {
  /** Arguments for the dataset's script (or extra action parameters); the target fills its own. */
  args?: Record<string, ScheduleArg>;
  /** How many finished runs to keep for one schedule (10-1000, default 200). */
  keepRuns?: number;
}

export interface ScheduleNotify {
  /** Counted per row; every row when absent. */
  when?: Cond;
  title: string;
  message: string;
  severity?: 'info' | 'warning';
}

export type ScheduleRun =
  | { dataset: string }
  | { action: string; params?: Record<string, ScheduleArg> };

export interface ScheduleSpec {
  id: string;
  label: string;
  description?: string;
  run: ScheduleRun;
  target?: ScheduleTarget;
  options?: ScheduleOptions;
  notify?: ScheduleNotify;
}

const MAX_SCHEDULES = 20;
const MAX_ARGS = 40;

function argObject(raw: unknown, where: string): Validated<Record<string, ScheduleArg> | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (!isObj(raw)) return fail(`${where} must be an object`);
  if (Object.keys(raw).length > MAX_ARGS) return fail(`${where} may hold at most ${MAX_ARGS} values`);
  for (const [k, v] of Object.entries(raw)) {
    if (!/^[a-z][a-zA-Z0-9_]{0,29}$/.test(k)) return fail(`${where}: "${k}" is not a parameter name`);
    if (!scalar(v)) return fail(`${where}: "${k}" must be a string, number or boolean`);
  }
  return { ok: true, value: raw as Record<string, ScheduleArg> };
}

function declaredParams(run: ScheduleRun, actions: ActionSpec[], datasets: Record<string, DatasetSpec>, scripts: Record<string, ScriptSpec>): {
  params: Record<string, ParamSpec>; targetParam: string | null; targetKind: 'stack' | 'container' | null; targetKindParam: string | null;
} | null {
  if ('dataset' in run) {
    const ds = datasets[run.dataset];
    if (!ds) return null;
    return {
      params: scripts[ds.script]?.params ?? {},
      targetParam: ds.target?.param ?? null,
      targetKind: ds.target ? fixedTargetKind(ds.target) : null,
      targetKindParam: ds.target ? targetKindParam(ds.target) : null,
    };
  }
  const action = actions.find(a => a.id === run.action);
  if (!action) return null;
  return {
    params: action.params,
    targetParam: action.target?.param ?? null,
    targetKind: action.target ? fixedTargetKind(action.target) : null,
    targetKindParam: action.target ? targetKindParam(action.target) : null,
  };
}

function validateNotify(raw: unknown, where: string): Validated<ScheduleNotify | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (!isObj(raw)) return fail(`${where} must be an object`);
  const title = text(raw.title, 200);
  if (!title) return fail(`${where}: a title is required (at most 200 characters)`);
  const message = text(raw.message, 1000);
  if (!message) return fail(`${where}: a message is required (at most 1000 characters)`);
  const severity = raw.severity === undefined ? undefined : raw.severity;
  if (severity !== undefined && severity !== 'info' && severity !== 'warning') return fail(`${where}: severity must be "info" or "warning"`);
  let when: Cond | undefined;
  if (raw.when !== undefined) {
    const c = cond(raw.when, `${where}.when`);
    if (!c.ok) return c;
    when = c.value;
  }
  return { ok: true, value: { title, message, ...(severity ? { severity } : {}), ...(when ? { when } : {}) } };
}

function validateOptions(raw: unknown, where: string): Validated<ScheduleOptions | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (!isObj(raw)) return fail(`${where} must be an object`);
  for (const k of Object.keys(raw)) if (k !== 'args' && k !== 'keepRuns') return fail(`${where} only knows "args" and "keepRuns"`);
  const args = argObject(raw.args, `${where}.args`);
  if (!args.ok) return args;
  const keepRuns = intIn(raw.keepRuns, 10, 1000, 200);
  if (keepRuns === null) return fail(`${where}: keepRuns must be a whole number from 10 to 1000`);
  return { ok: true, value: { ...(args.value ? { args: args.value } : {}), ...(raw.keepRuns !== undefined ? { keepRuns } : {}) } };
}

function validateOne(
  raw: unknown,
  actions: ActionSpec[],
  datasets: Record<string, DatasetSpec>,
  scripts: Record<string, ScriptSpec>,
): Validated<ScheduleSpec> {
  if (!isObj(raw)) return fail('each schedule must be an object');
  const id = typeof raw.id === 'string' ? raw.id : '';
  const where = `schedule "${id}"`;
  if (!ID_RE.test(id)) return fail(`${where}: ids are lowercase letters, digits and underscores, starting with a letter`);
  const label = text(raw.label, 60);
  if (!label) return fail(`${where}: a label is required (at most 60 characters)`);
  if (raw.description !== undefined && (typeof raw.description !== 'string' || raw.description.length > 300)) {
    return fail(`${where}: description must be at most 300 characters`);
  }
  const target = raw.target;
  if (target !== undefined && target !== 'server' && target !== 'stack' && target !== 'container' && target !== 'byKind') {
    return fail(`${where}: target must be "server", "stack", "container" or "byKind"`);
  }
  if (!isObj(raw.run)) return fail(`${where}: "run" must be an object`);
  const runRaw = raw.run;
  for (const k of Object.keys(runRaw)) if (k !== 'dataset' && k !== 'action' && k !== 'params') return fail(`${where}: "run" only knows "dataset", "action" and "params"`);
  const hasDataset = runRaw.dataset !== undefined;
  const hasAction = runRaw.action !== undefined;
  if (hasDataset === hasAction) return fail(`${where}: "run" must name exactly one of a dataset or an action`);
  if (hasDataset && runRaw.params !== undefined) return fail(`${where}: a dataset run takes its arguments in options.args, not run.params`);

  let run: ScheduleRun;
  if (hasDataset) {
    if (typeof runRaw.dataset !== 'string' || !(runRaw.dataset in datasets)) return fail(`${where}: run.dataset must name one of the widget's datasets`);
    run = { dataset: runRaw.dataset };
  } else {
    const action = actions.find(a => a.id === runRaw.action);
    if (!action || (action.kind !== 'script' && action.kind !== 'command')) return fail(`${where}: run.action must name one of the widget's runnable actions`);
    const params = argObject(runRaw.params, `${where}: run.params`);
    if (!params.ok) return params;
    run = { action: action.id, ...(params.value ? { params: params.value } : {}) };
  }

  const options = validateOptions(raw.options, `${where}: options`);
  if (!options.ok) return options;
  const notify = validateNotify(raw.notify, `${where}: notify`);
  if (!notify.ok) return notify;
  if (notify.value && hasAction && notify.value.when) return fail(`${where}: an action run's notify is raised when the run succeeds, so it takes no "when"`);
  if (hasAction && options.value?.args) return fail(`${where}: an action run takes its parameters in run.params, not options.args`);

  const declared = declaredParams(run, actions, datasets, scripts);
  if (!declared) return fail(`${where}: the run no longer exists in this package`);
  const fixed = ('action' in run ? run.params : options.value?.args) ?? {};
  for (const name of Object.keys(fixed)) {
    if (!(name in declared.params) && name !== declared.targetParam) return fail(`${where}: the run has no parameter "${name}"`);
  }
  const aimed = target === 'stack' || target === 'container' || target === 'byKind';
  if (target === 'byKind' && !declared.targetKindParam) {
    return fail(`${where}: a "byKind" schedule needs a run that acts on a container or a stack (target.byKind)`);
  }
  if (aimed && declared.targetKindParam && target !== 'byKind') {
    return fail(`${where}: a "${target}" schedule needs a run whose target is fixed, not taken from a parameter`);
  }
  if (aimed && target !== 'byKind' && declared.targetKind !== target) {
    return fail(`${where}: a "${target}" schedule needs a run that declares "${target}" as its target`);
  }
  if (declared.targetParam && !aimed && fixed[declared.targetParam] === undefined) {
    return fail(`${where}: the run acts on one ${declared.targetKind ?? 'container or stack'}; set target to "${declared.targetKind ?? 'byKind'}" or give "${declared.targetParam}" in its arguments`);
  }
  if (declared.targetKindParam && !aimed && fixed[declared.targetKindParam] === undefined) {
    return fail(`${where}: the run needs "${declared.targetKindParam}" ("container" or "stack"); set target to "byKind" or give it in its arguments`);
  }
  if (aimed && declared.targetParam && fixed[declared.targetParam] !== undefined) {
    return fail(`${where}: "${declared.targetParam}" is filled from the schedule's target, so do not set it too`);
  }
  if (aimed && declared.targetKindParam && fixed[declared.targetKindParam] !== undefined) {
    return fail(`${where}: "${declared.targetKindParam}" is filled from the schedule's target, so do not set it too`);
  }
  for (const name of Object.keys(declared.params)) {
    const satisfied = fixed[name] !== undefined
      || (aimed && (name === declared.targetParam || name === declared.targetKindParam))
      // A dataset script may rely on its own declared defaults (loadDataset fills them); an action may not,
      // because Bosun never fills in action parameter defaults.
      || (!hasAction && declared.params[name].default !== undefined);
    if (!satisfied) return fail(`${where}: the run needs the parameter "${name}"`);
  }
  // Validate the values that are fixed here (and a dataset's own defaults) with the same rules an ordinary call uses.
  const providedSpecs = Object.fromEntries(Object.entries(declared.params).filter(([name, spec]) =>
    fixed[name] !== undefined || (!hasAction && spec.default !== undefined)));
  const providedValues = Object.fromEntries(Object.entries(providedSpecs).map(([name, spec]) =>
    [name, fixed[name] ?? spec.default as ScheduleArg]));
  if (Object.keys(providedSpecs).length) {
    try {
      validateParamValues(providedSpecs, providedValues);
    } catch (err) {
      return fail(`${where}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    ok: true,
    value: {
      id, label,
      ...(raw.description ? { description: String(raw.description) } : {}),
      run,
      ...(target ? { target: target as ScheduleTarget } : {}),
      ...(options.value ? { options: options.value } : {}),
      ...(notify.value ? { notify: notify.value } : {}),
    },
  };
}

/** Validate the `schedules` list of a widget spec. */
export function validateSchedules(
  raw: unknown,
  actions: ActionSpec[],
  datasets: Record<string, DatasetSpec>,
  scripts: Record<string, ScriptSpec>,
): Validated<ScheduleSpec[]> {
  if (raw === undefined) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return fail('"schedules" must be a list');
  if (raw.length > MAX_SCHEDULES) return fail(`"schedules" may declare at most ${MAX_SCHEDULES} kinds`);
  const out: ScheduleSpec[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const v = validateOne(item, actions, datasets, scripts);
    if (!v.ok) return v;
    if (seen.has(v.value.id)) return fail(`schedule "${v.value.id}" is listed twice`);
    seen.add(v.value.id);
    out.push(v.value);
  }
  return { ok: true, value: out };
}
