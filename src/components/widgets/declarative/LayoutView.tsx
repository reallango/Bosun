'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, Loader2, Plus, X } from 'lucide-react';
import type { Block, EditorField, FormField } from '@/lib/widgets/runtime/spec-v2';
import type { ViewSpec } from '@/lib/widgets/runtime/spec';
import {
  actionApplies, editorFieldVisible, editorInitial, editorMissing, editorOptions, editorSubmitParams, editorWarnings, formInitial, formParams, jobHeadline, selectCurrent, selectParams, text, visible, visibleBadges,
  type EditorValue, type EditorValues, type JobState, type PublicActionLike, type ViewContext,
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
  /** Submit an action from an editor and learn how it went (true = it ran and succeeded). */
  submit?: (action: PublicActionLike, params: Record<string, unknown>) => Promise<boolean>;
  /** An editor's submit finished (screens close their dialog on success). */
  onSubmitted?: (ok: boolean) => void;
  /** Bigger text and fields, for dialogs and pages. */
  large?: boolean;
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
    case 'tabs': return <Tabs block={block} ctx={ctx} ui={ui} />;
    case 'editor': return <Editor block={block} ctx={ctx} ui={ui} />;
    case 'view': {
      // A path that starts with `datasets.` or `context.` reads the screen's context; any other reads the widget's data.
      const data = block.path ? (/^(datasets|context)\./.test(block.path) ? pathOf(ctx, block.path) : pathOf(ctx.data, block.path)) : ctx.data;
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

function Tabs({ block, ctx, ui }: { block: Extract<Block, { type: 'tabs' }>; ctx: ViewContext; ui: LayoutUi }) {
  const [active, setActive] = useState(block.tabs[0]?.id);
  const tab = block.tabs.find(t => t.id === active) ?? block.tabs[0];
  return (
    <div className="space-y-3">
      <div role="tablist" className="flex flex-wrap gap-1 border-b border-gray-200 dark:border-gray-800">
        {block.tabs.map(t => (
          <button key={t.id} type="button" role="tab" aria-selected={t.id === tab.id} onClick={() => setActive(t.id)}
            className={`-mb-px rounded-t-md border-b-2 px-3 py-1.5 ${ui.large ? 'text-sm' : 'text-xs'} font-medium ${t.id === tab.id ? 'border-blue-500 text-blue-600 dark:text-blue-400' : 'border-transparent text-gray-500 hover:text-gray-900 dark:hover:text-gray-100'}`}>
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel"><LayoutBlocks blocks={tab.blocks} ctx={ctx} ui={ui} /></div>
    </div>
  );
}

function Editor({ block, ctx, ui }: { block: Extract<Block, { type: 'editor' }>; ctx: ViewContext; ui: LayoutUi }) {
  const [values, setValues] = useState<EditorValues>(() => editorInitial(block.fields, ctx));
  const [problem, setProblem] = useState<string | null>(null);
  const [sending, setSending] = useState<string | null>(null);
  const big = ui.large === true;
  const field = `w-full rounded-md border border-gray-200 bg-transparent px-2 ${big ? 'py-1.5 text-sm' : 'py-1 text-xs'} outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-700`;
  const set = (name: string, v: EditorValue) => setValues(s => ({ ...s, [name]: v }));
  const warnings = editorWarnings(block.fields, values);

  const send = async (s: (typeof block.submits)[number]) => {
    const action = ui.actions.get(s.action);
    if (!action || !ui.submit) return;
    const missing = editorMissing(block.fields, values);
    if (missing.length) { setProblem(`Fill in: ${missing.join(', ')}`); return; }
    const { params, missing: lacking } = editorSubmitParams(action, s, block.param, block.fields, values, ctx);
    if (lacking.length) { setProblem(`This screen cannot fill: ${lacking.join(', ')}`); return; }
    setProblem(null);
    setSending(s.action + s.label);
    try { ui.onSubmitted?.(await ui.submit(action, params)); } finally { setSending(null); }
  };

  const rows = (f: EditorField): string[] => (Array.isArray(values[f.name]) ? (values[f.name] as string[]) : []);
  const setRow = (f: EditorField, i: number, v: string) => set(f.name, rows(f).map((r, j) => (j === i ? v : r)));
  const removeRow = (f: EditorField, i: number) => set(f.name, rows(f).filter((_, j) => j !== i));
  const addRow = (f: EditorField) => set(f.name, [...rows(f), '']);

  return (
    <div className="space-y-3">
      {block.fields.filter(f => editorFieldVisible(f, values)).map(f => {
        if (f.input === 'heading') return <h4 key={f.name} className={`pt-2 font-semibold ${big ? 'text-sm' : 'text-xs'}`}>{f.label}</h4>;
        const used = f.warn && (f.input === 'checkbox' ? values[f.name] === true : Array.isArray(values[f.name]) ? rows(f).some(r => r.trim() !== '') : String(values[f.name] ?? '').trim() !== '');
        const label = <span className={`${big ? 'text-sm' : 'text-xs'} text-gray-600 dark:text-gray-400`}>{f.label}{f.required && <span className="text-red-500"> *</span>}</span>;
        let control: React.ReactNode;
        if (f.input === 'checkbox') {
          return (
            <div key={f.name} className="space-y-0.5">
              <label className={`flex items-center gap-2 ${big ? 'text-sm' : 'text-xs'}`}>
                <input type="checkbox" checked={values[f.name] === true} onChange={e => set(f.name, e.target.checked)} /> {f.label}
              </label>
              {f.help && <span className="block text-[11px] text-gray-500">{f.help}</span>}
              {used && <Warn text={f.warn!} />}
            </div>
          );
        }
        if (f.input === 'select') {
          const opts = editorOptions(f, ctx);
          const cur = String(values[f.name] ?? '');
          control = (
            <select className={field} value={cur} onChange={e => set(f.name, e.target.value)}>
              {!opts.some(o => o.value === cur) && <option value={cur}>{cur || '—'}</option>}
              {opts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          );
        } else if (f.input === 'textarea') {
          control = <textarea className={`${field} min-h-24 font-mono`} value={String(values[f.name] ?? '')} placeholder={f.placeholder} spellCheck={false} onChange={e => set(f.name, e.target.value)} />;
        } else if (f.input === 'lines' || f.input === 'pairs') {
          control = (
            <div className="space-y-1.5">
              {rows(f).map((r, i) => {
                const eq = r.indexOf('=');
                const k = f.input === 'pairs' ? (eq < 0 ? r : r.slice(0, eq)) : '';
                const v = f.input === 'pairs' ? (eq < 0 ? '' : r.slice(eq + 1)) : r;
                return (
                  <div key={i} className="flex items-center gap-1.5">
                    {f.input === 'pairs'
                      ? (
                        <>
                          <input className={`${field} basis-2/5 font-mono`} value={k} placeholder="name" spellCheck={false} aria-label={`${f.label} name ${i + 1}`} onChange={e => setRow(f, i, `${e.target.value}=${v}`)} />
                          <input className={`${field} font-mono`} value={v} placeholder="value" spellCheck={false} aria-label={`${f.label} value ${i + 1}`} onChange={e => setRow(f, i, `${k}=${e.target.value}`)} />
                        </>
                      )
                      : <input className={`${field} font-mono`} value={v} placeholder={f.placeholder} spellCheck={false} aria-label={`${f.label} ${i + 1}`} onChange={e => setRow(f, i, e.target.value)} />}
                    <button type="button" className="rounded p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-900 dark:hover:bg-gray-800" aria-label={`Remove ${f.label} ${i + 1}`} onClick={() => removeRow(f, i)}><X className="size-3.5" /></button>
                  </div>
                );
              })}
              <button type="button" className={buttonClass} onClick={() => addRow(f)}><Plus className="size-3" aria-hidden /> Add</button>
            </div>
          );
        } else {
          control = <input className={field} type={f.input === 'number' ? 'number' : 'text'} value={String(values[f.name] ?? '')} placeholder={f.placeholder} spellCheck={false} onChange={e => set(f.name, e.target.value)} />;
        }
        return (
          <div key={f.name} className="space-y-0.5">
            {f.input === 'lines' || f.input === 'pairs' ? <div>{label}</div> : <label className="block space-y-0.5">{label}{control}</label>}
            {(f.input === 'lines' || f.input === 'pairs') && control}
            {f.help && <span className="block text-[11px] text-gray-500">{f.help}</span>}
            {used && <Warn text={f.warn!} />}
          </div>
        );
      })}
      {problem && <div role="alert" className="text-xs text-red-600 dark:text-red-400">{problem}</div>}
      {warnings.length > 0 && <div role="status" className="rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">Elevated options are set: they can give this container control over the host.</div>}
      <div className="flex flex-wrap gap-2 pt-1">
        {block.submits.map(s => {
          const action = ui.actions.get(s.action);
          if (!action || !ui.allowed(action) || !actionApplies(action, ctx)) return null;
          return (
            <button key={s.action + s.label} type="button" disabled={ui.busy !== null || sending !== null}
              className={`inline-flex items-center gap-1 rounded-md px-3 py-1.5 ${big ? 'text-sm' : 'text-xs'} font-medium text-white disabled:opacity-40 ${s.style === 'danger' ? 'bg-red-600 hover:bg-red-700' : 'bg-blue-600 hover:bg-blue-700'}`}
              onClick={() => send(s)}>
              {sending === s.action + s.label && <Loader2 className="size-3 animate-spin motion-reduce:animate-none" aria-hidden />}{s.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Warn({ text: t }: { text: string }) {
  return <span className="flex items-start gap-1 text-[11px] text-amber-700 dark:text-amber-400"><AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />{t}</span>;
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
