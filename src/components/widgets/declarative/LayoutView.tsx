'use client';

import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import type { Block, FormField } from '@/lib/widgets/runtime/spec-v2';
import type { ViewSpec } from '@/lib/widgets/runtime/spec';
import {
  actionApplies, formInitial, formParams, jobHeadline, selectCurrent, selectParams, text, visible, visibleBadges,
  type JobState, type PublicActionLike, type ViewContext,
} from '@/lib/widgets/runtime/layout';
import { Bar, Fields } from './parts';

const BADGE: Record<string, string> = {
  green: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
  amber: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  red: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
  gray: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  blue: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
};
const NOTICE: Record<string, string> = {
  info: 'border-blue-200 bg-blue-50 text-blue-900 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-200',
  warning: 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200',
  error: 'border-red-300 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200',
};
const FINISHED_JOB_SHOWN_MS = 10 * 60 * 1000;

/** What the layout needs from the widget around it. */
export interface LayoutUi {
  actions: Map<string, PublicActionLike>;
  /** May the person use this action (its permission, and for a terminal also the role)? */
  allowed: (action: PublicActionLike) => boolean;
  busy: string | null;
  /** Start an action with these parameters (asks for confirmation first when the action does). */
  onAction: (action: PublicActionLike, params: Record<string, unknown>) => void;
  /** A version 1 view over a part of the data (a `view` block). */
  renderView: (view: ViewSpec, data: unknown) => React.ReactNode;
  onCancelJob: () => void;
}

const inputClass = 'w-full rounded-md border border-gray-200 bg-transparent px-2 py-1 text-xs outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-700';
const buttonClass = 'inline-flex items-center gap-1 rounded-md border border-gray-200 px-2 py-1 text-xs font-medium hover:bg-gray-100 disabled:opacity-40 dark:border-gray-700 dark:hover:bg-gray-800';

export function LayoutBlocks({ blocks, ctx, ui }: { blocks: Block[]; ctx: ViewContext; ui: LayoutUi }) {
  return (
    <div className="space-y-2">
      {blocks.filter(b => visible(b, ctx)).map((b, i) => <BlockView key={i} block={b} ctx={ctx} ui={ui} />)}
    </div>
  );
}

function BlockView({ block, ctx, ui }: { block: Block; ctx: ViewContext; ui: LayoutUi }) {
  switch (block.type) {
    case 'section': return <Section block={block} ctx={ctx} ui={ui} />;
    case 'kv': return <Fields fields={block.items} data={ctx} />;
    case 'text': return <p className="whitespace-pre-wrap break-words text-xs text-gray-700 dark:text-gray-300">{text(block.text, ctx)}</p>;
    case 'notice': return <div role={block.level === 'error' ? 'alert' : 'status'} className={`rounded-md border px-2 py-1.5 text-xs ${NOTICE[block.level]}`}>{text(block.text, ctx)}</div>;
    case 'buttons': return <Buttons block={block} ctx={ctx} ui={ui} />;
    case 'form': return <Form block={block} ctx={ctx} ui={ui} />;
    case 'select': return <SelectBlock block={block} ctx={ctx} ui={ui} />;
    case 'jobProgress': return <JobProgress job={ctx.job ?? null} ui={ui} />;
    case 'view': {
      const data = block.path ? pathOf(ctx.data, block.path) : ctx.data;
      return <>{ui.renderView(block.view, data)}</>;
    }
  }
}

function pathOf(data: unknown, path: string): unknown {
  let cur: unknown = data;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, part)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function Section({ block, ctx, ui }: { block: Extract<Block, { type: 'section' }>; ctx: ViewContext; ui: LayoutUi }) {
  const [open, setOpen] = useState(block.defaultOpen);
  const badges = visibleBadges(block.badges, ctx);
  const summary = block.summary ? text(block.summary, ctx) : '';
  return (
    <section className="rounded-lg border border-gray-200 dark:border-gray-800">
      <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-gray-50 dark:hover:bg-gray-800/50">
        {open ? <ChevronDown className="size-3.5 shrink-0 text-gray-500" aria-hidden /> : <ChevronRight className="size-3.5 shrink-0 text-gray-500" aria-hidden />}
        <span className="text-xs font-semibold">{block.title}</span>
        {badges.map((b, i) => <span key={i} className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${BADGE[b.color]}`}>{b.text}</span>)}
        {!open && summary && <span className="ml-auto min-w-0 truncate text-xs text-gray-500">{summary}</span>}
      </button>
      {open && <div className="border-t border-gray-100 p-2 dark:border-gray-800"><LayoutBlocks blocks={block.blocks} ctx={ctx} ui={ui} /></div>}
    </section>
  );
}

function Buttons({ block, ctx, ui }: { block: Extract<Block, { type: 'buttons' }>; ctx: ViewContext; ui: LayoutUi }) {
  const list = block.actions.map(id => ui.actions.get(id)).filter((a): a is PublicActionLike => !!a && ui.allowed(a) && actionApplies(a, ctx));
  if (!list.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {list.map(a => {
        const params: Record<string, unknown> = {};
        for (const [n, p] of Object.entries(a.params ?? {})) if (p.default !== undefined) params[n] = p.default;
        const needsInput = Object.keys(a.params ?? {}).some(n => params[n] === undefined);
        return (
          <button key={a.id} type="button" className={buttonClass} disabled={ui.busy !== null || needsInput || (a.job && (ctx.job?.status === 'running'))}
            title={needsInput ? 'This action needs a value: use its form' : a.description} onClick={() => ui.onAction(a, params)}>
            {ui.busy === a.id && <Loader2 className="size-3 animate-spin motion-reduce:animate-none" aria-hidden />}{a.label}
          </button>
        );
      })}
    </div>
  );
}

function Form({ block, ctx, ui }: { block: Extract<Block, { type: 'form' }>; ctx: ViewContext; ui: LayoutUi }) {
  const initial = formInitial(block.fields, ctx);
  const key = JSON.stringify(initial);
  const [values, setValues] = useState<Record<string, string>>(initial);
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [problem, setProblem] = useState<string | null>(null);
  // A field the person has not touched follows the current value of the host.
  useEffect(() => {
    setValues(v => Object.fromEntries(Object.entries(initial).map(([k, x]) => [k, touched.has(k) ? v[k] : x])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const action = ui.actions.get(block.submit.action);
  if (!action || !ui.allowed(action) || !actionApplies(action, ctx)) return null;
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const { params, missing } = formParams(action, block.submit, block.fields, values);
    if (missing.length) { setProblem(`Fill in: ${missing.join(', ')}`); return; }
    setProblem(null);
    ui.onAction(action, params);
  };
  const set = (f: FormField, v: string) => { setTouched(t => new Set(t).add(f.name)); setValues(s => ({ ...s, [f.name]: v })); };
  return (
    <form onSubmit={submit} className="space-y-2">
      {block.title && <div className="text-xs font-semibold">{block.title}</div>}
      {block.fields.map(f => (
        <label key={f.name} className="block space-y-0.5">
          <span className="text-xs text-gray-500">{f.label}</span>
          {f.input === 'select'
            ? <select className={inputClass} value={values[f.name] ?? ''} onChange={e => set(f, e.target.value)}>{f.options?.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
            : <input className={inputClass} type={f.input === 'number' ? 'number' : 'text'} value={values[f.name] ?? ''} placeholder={f.placeholder} onChange={e => set(f, e.target.value)} />}
          {f.help && <span className="block text-[11px] text-gray-500">{f.help}</span>}
        </label>
      ))}
      {problem && <div role="alert" className="text-xs text-red-600 dark:text-red-400">{problem}</div>}
      <button type="submit" className={buttonClass} disabled={ui.busy !== null || (action.job && ctx.job?.status === 'running')}>
        {ui.busy === action.id && <Loader2 className="size-3 animate-spin motion-reduce:animate-none" aria-hidden />}{block.submit.label}
      </button>
    </form>
  );
}

function SelectBlock({ block, ctx, ui }: { block: Extract<Block, { type: 'select' }>; ctx: ViewContext; ui: LayoutUi }) {
  const action = ui.actions.get(block.action);
  if (!action || !ui.allowed(action) || !actionApplies(action, ctx)) return null;
  const current = selectCurrent(block, ctx);
  return (
    <label className="flex items-center justify-between gap-2 text-xs">
      <span className="text-gray-500">{block.label}</span>
      <select className={`${inputClass} w-auto max-w-[60%]`} value={current} disabled={ui.busy !== null} aria-label={block.label}
        onChange={e => { const { params, ok } = selectParams(action, block.param, e.target.value); if (ok) ui.onAction(action, params); }}>
        {!block.options.some(o => o.value === current) && <option value={current}>{current || '—'}</option>}
        {block.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}

function JobProgress({ job, ui }: { job: JobState | null; ui: LayoutUi }) {
  const [dismissed, setDismissed] = useState<string | null>(null);
  if (!job || dismissed === job.id) return null;
  const finishedAt = job.finishedAt;
  if (job.status !== 'running' && finishedAt && Date.now() - finishedAt > FINISHED_JOB_SHOWN_MS) return null;
  const action = ui.actions.get(job.actionId);
  const running = job.status === 'running';
  const tone = job.status === 'success' ? NOTICE.info : running ? 'border-gray-200 dark:border-gray-800' : NOTICE.error;
  const steps = job.steps.slice(-5);
  return (
    <div className={`space-y-1.5 rounded-md border p-2 text-xs ${tone}`} role="status" aria-live="polite">
      <div className="flex items-center gap-2">
        {running && <Loader2 className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />}
        <span className="min-w-0 flex-1 truncate font-medium">{jobHeadline(job, action?.label)}</span>
        {running && action && ui.allowed(action) && <button type="button" className={buttonClass} onClick={ui.onCancelJob}>Cancel</button>}
        {!running && <button type="button" className={buttonClass} onClick={() => setDismissed(job.id)}>Dismiss</button>}
      </div>
      {running && job.percent !== null && <Bar value={job.percent} color="bg-blue-500" />}
      {steps.length > 0 && (
        <ol className="space-y-0.5 text-[11px] text-gray-600 dark:text-gray-400">
          {steps.map((s, i) => <li key={i} className={i === steps.length - 1 && running ? 'font-medium text-gray-900 dark:text-gray-100' : ''}>{s}</li>)}
        </ol>
      )}
    </div>
  );
}
