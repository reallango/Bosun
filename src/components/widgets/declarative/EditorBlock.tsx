'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, Copy, Download, Loader2, Plus, Upload, X } from 'lucide-react';
import type { Block, EditorField, RowColumn } from '@/lib/widgets/runtime/spec-v2';
import {
  actionApplies, applyFill, datasetArgsFromForm, editorFieldVisible, editorInitial, editorMissing, editorOptions, editorSubmitParams,
  editorWarnings, hiddenByHeading, isSecretName, newEditorRow, remoteOptions,
  type EditorValue, type EditorValues, type RowValue, type ViewContext,
} from '@/lib/widgets/runtime/layout';
import type { LayoutUi } from './LayoutView';

const buttonClass = 'inline-flex items-center gap-1 rounded-md border border-gray-200 px-2 py-1 text-xs font-medium hover:bg-gray-100 disabled:opacity-40 dark:border-gray-700 dark:hover:bg-gray-800';

type EditorBlockSpec = Extract<Block, { type: 'editor' }>;
type Option = { value: string; label: string };

const asRows = (v: EditorValue | undefined): RowValue[] => (Array.isArray(v) ? (v as RowValue[]).filter(r => r && typeof r === 'object' && !Array.isArray(r)) : []);
const asStrings = (v: EditorValue | undefined): string[] => (Array.isArray(v) ? (v as unknown[]).filter((x): x is string => typeof x === 'string') : []);

export function Warn({ text: t }: { text: string }) {
  return <span className="flex items-start gap-1 text-[11px] text-amber-700 dark:text-amber-400"><AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />{t}</span>;
}

/** A `code` block: text from the context in a box, with Copy and Download. */
export function CodeBlock({ title, text, filename }: { title?: string; text: string; filename?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* the box can still be selected by hand */ }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url; a.download = filename || 'export.txt'; a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        {title && <span className="text-sm font-medium">{title}</span>}
        <span className="ml-auto flex gap-1.5">
          <button type="button" className={buttonClass} onClick={copy}><Copy className="size-3" aria-hidden /> {copied ? 'Copied' : 'Copy'}</button>
          <button type="button" className={buttonClass} onClick={download}><Download className="size-3" aria-hidden /> Download</button>
        </span>
      </div>
      <pre className="max-h-96 overflow-auto whitespace-pre rounded-md border border-gray-200 bg-gray-50 p-3 font-mono text-xs leading-snug dark:border-gray-800 dark:bg-gray-950">{text || '(nothing to show)'}</pre>
    </div>
  );
}

/** A select whose options come from the host (the branches of a repository), with an optional "Custom" entry that shows a box. */
function RemoteSelect({ f, value, onChange, ctx, values, ui, cls }: { f: EditorField; value: string; onChange: (v: string) => void; ctx: ViewContext; values: EditorValues; ui: LayoutUi; cls: string }) {
  const remote = f.remote!;
  const { args, missing } = datasetArgsFromForm(remote.args, values, ctx);
  const key = JSON.stringify([remote.dataset, args]);
  const [state, setState] = useState<{ loading: boolean; options: Option[]; error: string | null; done: boolean }>({ loading: false, options: [], error: null, done: false });
  const [custom, setCustom] = useState(false);
  const valueRef = useRef(value);
  valueRef.current = value;

  useEffect(() => {
    if (missing.length || !ui.loadDataset) { setState({ loading: false, options: [], error: null, done: false }); return; }
    let live = true;
    setState(s => ({ ...s, loading: true, error: null }));
    const timer = setTimeout(async () => {
      const r = await ui.loadDataset!(remote.dataset, args);
      if (!live) return;
      if (!r.ok) { setState({ loading: false, options: [], error: r.error, done: true }); setCustom(true); return; }
      const options = remoteOptions(f, r.data);
      setState({ loading: false, options, error: null, done: true });
      const cur = valueRef.current;
      if (!options.length) setCustom(true);
      else if (!cur) onChange(options[0].value);
      else if (!options.some(o => o.value === cur)) { if (f.custom) setCustom(true); else onChange(options[0].value); }
    }, 350);
    return () => { live = false; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const inList = state.options.some(o => o.value === value);
  const showBox = f.custom ? (custom || (state.done && !state.options.length)) : (state.done && !state.options.length);
  return (
    <div className="space-y-1">
      {state.options.length > 0 && (
        <select className={cls} value={showBox && !inList ? '__custom__' : value} disabled={state.loading}
          onChange={e => { if (e.target.value === '__custom__') { setCustom(true); } else { setCustom(false); onChange(e.target.value); } }}>
          {!inList && !showBox && <option value={value}>{value || '—'}</option>}
          {state.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          {f.custom && <option value="__custom__">{f.custom}</option>}
        </select>
      )}
      {(showBox || !state.options.length) && (
        <input className={cls} value={value} placeholder={f.placeholder} spellCheck={false} onChange={e => onChange(e.target.value)} aria-label={f.label} />
      )}
      {state.loading && <span className="flex items-center gap-1 text-[11px] text-gray-500"><Loader2 className="size-3 animate-spin motion-reduce:animate-none" aria-hidden /> Asking the host…</span>}
      {state.error && <span className="block text-[11px] text-amber-700 dark:text-amber-400">Could not look this up: {state.error}. Type it instead.</span>}
      {missing.length > 0 && !state.loading && <span className="block text-[11px] text-gray-500">Fill in the field above to look up the choices.</span>}
    </div>
  );
}

/** The options a rows field's `remote` finds on the host (for its select columns marked remote), asked again when the arguments change. */
function useRemoteList(f: EditorField, values: EditorValues, ctx: ViewContext, ui: LayoutUi): { options: Option[]; loading: boolean; error: string | null } {
  const remote = f.remote;
  const { args, missing } = remote ? datasetArgsFromForm(remote.args, values, ctx) : { args: {}, missing: ['x'] };
  const key = JSON.stringify([remote?.dataset, args]);
  const [state, setState] = useState<{ options: Option[]; loading: boolean; error: string | null }>({ options: [], loading: false, error: null });
  useEffect(() => {
    if (!remote || missing.length || !ui.loadDataset) { setState({ options: [], loading: false, error: null }); return; }
    let live = true;
    setState(s => ({ ...s, loading: true, error: null }));
    const timer = setTimeout(async () => {
      const r = await ui.loadDataset!(remote.dataset, args);
      if (!live) return;
      setState(r.ok ? { options: remoteOptions(f, r.data), loading: false, error: null } : { options: [], loading: false, error: r.error });
    }, 400);
    return () => { live = false; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state;
}

/** The columns of a `rows` field as labelled boxes, one row per entry. */
function RowsField({ f, rows, onChange, ctx, cls, values, ui }: { f: EditorField; rows: RowValue[]; onChange: (rows: RowValue[]) => void; ctx: ViewContext; cls: string; values: EditorValues; ui: LayoutUi }) {
  const cols = f.columns as RowColumn[];
  const remote = useRemoteList(f, values, ctx, ui);
  const widths: Record<string, string> = { text: 'min-w-[7rem] flex-1', number: 'w-24', select: 'w-32' };
  const setCell = (i: number, name: string, v: string) => {
    onChange(rows.map((r, j) => {
      if (j !== i) return r;
      const next = { ...r, [name]: v };
      for (const [col, rule] of Object.entries(f.derive ?? {})) if (rule.from === name) next[col] = v.startsWith(rule.startsWith) ? rule.then : rule.else;
      return next;
    }));
  };
  const listId = (c: RowColumn) => `dl-${f.name}-${c.name}`;
  const suggestions = (c: RowColumn): string[] => {
    if (!c.suggest) return [];
    const list = ctx && (ctx as unknown as { datasets?: unknown }).datasets ? (c.suggest.path.split('.').reduce<unknown>((cur, p) => (cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[p] : undefined), ctx)) : undefined;
    return Array.isArray(list) ? list.map(x => String((x as Record<string, unknown>)?.[c.suggest!.value] ?? '')).filter(Boolean) : [];
  };
  return (
    <div className="space-y-1.5">
      {rows.length > 0 && (
        <div className="flex items-center gap-1.5 text-[11px] text-gray-500">
          {cols.map(c => <span key={c.name} className={widths[c.input]}>{c.label}</span>)}
          <span className="w-6" aria-hidden />
        </div>
      )}
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-1.5">
          {cols.map(c => (c.input === 'select' && !(c.remote && remote.options.length === 0)) ? (
            <select key={c.name} className={`${cls} ${widths.select}`} value={r[c.name] ?? ''} aria-label={`${f.label} ${c.label} ${i + 1}`} onChange={e => setCell(i, c.name, e.target.value)}>
              {!(c.remote ? remote.options : (c.options ?? [])).some(o => o.value === (r[c.name] ?? '')) && <option value={r[c.name] ?? ''}>{r[c.name] || '—'}</option>}
              {(c.remote ? remote.options : (c.options ?? [])).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          ) : (

            <span key={c.name} className={`${widths[c.input]} min-w-0`}>
              <input className={`${cls} font-mono`} type={c.input === 'number' ? 'number' : 'text'} value={r[c.name] ?? ''} placeholder={c.placeholder} spellCheck={false}
                list={c.suggest ? listId(c) : undefined} aria-label={`${f.label} ${c.label} ${i + 1}`} onChange={e => setCell(i, c.name, e.target.value)} />
              {c.suggest && i === 0 && <datalist id={listId(c)}>{suggestions(c).map(s => <option key={s} value={s} />)}</datalist>}
            </span>
          ))}
          <button type="button" className="rounded p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-900 dark:hover:bg-gray-800" aria-label={`Remove ${f.label} ${i + 1}`} onClick={() => onChange(rows.filter((_, j) => j !== i))}><X className="size-3.5" /></button>
        </div>
      ))}
      <button type="button" className={buttonClass} onClick={() => onChange([...rows, newEditorRow(f)])}><Plus className="size-3" aria-hidden /> Add</button>
    </div>
  );
}

interface ToolResult { errors: string[]; notes: string[]; applied: boolean }

export function EditorBlock({ block, ctx, ui }: { block: EditorBlockSpec; ctx: ViewContext; ui: LayoutUi }) {
  const [values, setValues] = useState<EditorValues>(() => {
    const initial = editorInitial(block.fields, ctx);
    // Reopened from a task: what was filled in then (secrets come back as placeholders).
    for (const f of block.fields) { const r = ctx.restore?.values[f.name]; if (r !== undefined && r !== null && f.input !== 'heading' && f.input !== 'button') initial[f.name] = r as EditorValue; }
    return initial;
  });
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [problem, setProblem] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [sending, setSending] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [toolBusy, setToolBusy] = useState<string | null>(null);
  const [toolResult, setToolResult] = useState<Record<string, ToolResult | undefined>>({});
  const big = ui.large === true;
  const field = `w-full rounded-md border border-gray-200 bg-transparent px-2 ${big ? 'py-1.5 text-sm' : 'py-1 text-xs'} outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-700`;
  const set = (name: string, v: EditorValue) => setValues(s => ({ ...s, [name]: v }));
  const warnings = editorWarnings(block.fields, values);
  const hidden = useMemo(() => hiddenByHeading(block.fields, open), [block.fields, open]);
  const errorRef = useRef<HTMLDivElement>(null);

  const send = async (s: (typeof block.submits)[number]) => {
    const action = ui.actions.get(s.action);
    if (!action || !ui.submit) return;
    const missing = editorMissing(block.fields, values);
    if (missing.length) { setProblem(`Fill in: ${missing.join(', ')}`); return; }
    const { params, missing: lacking } = editorSubmitParams(action, s, block.param, block.fields, values, ctx);
    if (lacking.length) { setProblem(`This screen cannot fill: ${lacking.join(', ')}`); return; }
    setProblem(null); setFailure(null);
    setSending(s.action + s.label);
    try {
      const sendable = Object.fromEntries(block.fields.filter(x => x.input !== 'heading' && x.input !== 'button' && !x.transient).map(x => [x.name, values[x.name]]));
      const extra = ctx.screenId ? { origin: { screenId: ctx.screenId, context: ctx.context ?? null, values: sendable }, ...(ctx.restore ? { savedFrom: ctx.restore.savedFrom } : {}) } : undefined;
      const r = await ui.submit(action, params, extra);
      if (!r.ok) { setFailure(r.error ?? null); setTimeout(() => errorRef.current?.scrollIntoView({ block: 'nearest' }), 50); }
      ui.onSubmitted?.(r.ok);
    } finally { setSending(null); }
  };

  const runTool = async (f: EditorField) => {
    if (!f.tool || !ui.loadDataset) return;
    const { args, missing } = datasetArgsFromForm(f.tool.args, values, ctx);
    if (missing.length) { setToolResult(r => ({ ...r, [f.name]: { errors: ['Fill in the box first.'], notes: [], applied: false } })); return; }
    setToolBusy(f.name);
    try {
      const r = await ui.loadDataset(f.tool.dataset, args);
      if (!r.ok) { setToolResult(x => ({ ...x, [f.name]: { errors: [r.error], notes: [], applied: false } })); return; }
      const data = (r.data ?? {}) as { fill?: unknown; errors?: unknown; notes?: unknown };
      const errors = Array.isArray(data.errors) ? data.errors.map(String) : [];
      const notes = Array.isArray(data.notes) ? data.notes.map(String) : [];
      const applied = applyFill(block.fields, values, data.fill, ctx);
      const hasFill = data.fill && typeof data.fill === 'object' && Object.keys(data.fill as object).length > 0;
      if (hasFill) setValues(applied.values);
      if (applied.unknown.length) errors.push(`The host answered with settings this form does not have: ${applied.unknown.join(', ')}`);
      setToolResult(x => ({ ...x, [f.name]: { errors, notes, applied: !!hasFill } }));
    } finally { setToolBusy(null); }
  };

  const upload = (f: EditorField, file: File | undefined) => {
    if (!file) return;
    if (file.size > 256 * 1024) { setProblem('That file is too large (256 KB at most).'); return; }
    void file.text().then(t => set(f.name, t));
  };

  const renderField = (f: EditorField) => {
    if (f.input === 'heading') {
      if (f.collapsed) {
        const isOpen = open.has(f.name);
        return (
          <button key={f.name} type="button" aria-expanded={isOpen} className={`mt-1 flex w-full items-center gap-1 rounded-md border border-gray-200 px-2 py-1.5 text-left font-semibold hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-800/50 ${big ? 'text-sm' : 'text-xs'}`}
            onClick={() => setOpen(s => { const n = new Set(s); if (n.has(f.name)) n.delete(f.name); else n.add(f.name); return n; })}>
            {isOpen ? <ChevronDown className="size-3.5" aria-hidden /> : <ChevronRight className="size-3.5" aria-hidden />}{f.label}
          </button>
        );
      }
      return <h4 key={f.name} className={`pt-2 font-semibold ${big ? 'text-sm' : 'text-xs'}`}>{f.label}</h4>;
    }
    if (f.input === 'button') {
      const res = toolResult[f.name];
      return (
        <div key={f.name} className="space-y-1.5">
          <button type="button" className={`${buttonClass} ${big ? '!text-sm' : ''}`} disabled={toolBusy !== null} onClick={() => runTool(f)}>
            {toolBusy === f.name && <Loader2 className="size-3 animate-spin motion-reduce:animate-none" aria-hidden />}{toolBusy === f.name && f.tool?.busy ? f.tool.busy : f.label}
          </button>
          {res && res.errors.length > 0 && (
            <div role="alert" className="space-y-0.5 rounded-md border border-red-300 bg-red-50 px-2 py-1.5 text-xs text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
              <div className="font-medium">{res.applied ? 'Imported what could be converted. These parts were not:' : 'Nothing could be imported:'}</div>
              <ul className="list-disc pl-4">{res.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
            </div>
          )}
          {res && res.errors.length === 0 && res.applied && <div role="status" className="rounded-md border border-green-300 bg-green-50 px-2 py-1 text-xs text-green-900 dark:border-green-900 dark:bg-green-950/40 dark:text-green-200">Done. Check the fields below.</div>}
          {res && res.notes.length > 0 && <ul className="list-disc space-y-0.5 pl-5 text-[11px] text-gray-600 dark:text-gray-400">{res.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
        </div>
      );
    }
    const used = f.warn && (f.input === 'checkbox' ? values[f.name] === true : Array.isArray(values[f.name]) ? (values[f.name] as unknown[]).length > 0 : String(values[f.name] ?? '').trim() !== '');
    const label = <span className={`${big ? 'text-sm' : 'text-xs'} text-gray-600 dark:text-gray-400`}>{f.label}{f.required && <span className="text-red-500"> *</span>}</span>;
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
    let control: React.ReactNode;
    let labelled = true;   // false when the control needs its own label line (several boxes)
    if (f.input === 'select' && f.remote) {
      control = <RemoteSelect f={f} value={String(values[f.name] ?? '')} onChange={v => set(f.name, v)} ctx={ctx} values={values} ui={ui} cls={field} />;
      labelled = false;
    } else if (f.input === 'select') {
      const opts = editorOptions(f, ctx);
      const cur = String(values[f.name] ?? '');
      control = (
        <select className={field} value={cur} onChange={e => set(f.name, e.target.value)}>
          {!opts.some(o => o.value === cur) && <option value={cur}>{cur || '—'}</option>}
          {opts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      );
    } else if (f.input === 'textarea') {
      control = <textarea className={`${field} font-mono`} rows={f.height ?? 6} value={String(values[f.name] ?? '')} placeholder={f.placeholder} spellCheck={false} onChange={e => set(f.name, e.target.value)} />;
      if (f.upload) {
        labelled = false;
        const fileInput = (
          <label className={`${buttonClass} cursor-pointer`}>
            <Upload className="size-3" aria-hidden /> Upload
            <input type="file" className="sr-only" accept=".yml,.yaml,.txt,.json,.md,.env,text/*" onChange={e => { upload(f, e.target.files?.[0]); e.target.value = ''; }} />
          </label>
        );
        control = <div className="space-y-1.5">{control}<div>{fileInput}</div></div>;
      }
    } else if (f.input === 'rows') {
      control = <RowsField f={f} rows={asRows(values[f.name])} onChange={rows => set(f.name, rows)} ctx={ctx} cls={field} values={values} ui={ui} />;
      labelled = false;
    } else if (f.input === 'lines' || f.input === 'pairs') {
      const rows = asStrings(values[f.name]);
      const setRow = (i: number, v: string) => set(f.name, rows.map((r, j) => (j === i ? v : r)));
      control = (
        <div className="space-y-1.5">
          {rows.map((r, i) => {
            const eq = r.indexOf('=');
            const k = f.input === 'pairs' ? (eq < 0 ? r : r.slice(0, eq)) : '';
            const v = f.input === 'pairs' ? (eq < 0 ? '' : r.slice(eq + 1)) : r;
            return (
              <div key={i} className="flex items-center gap-1.5">
                {f.input === 'pairs'
                  ? (
                    <>
                      <input className={`${field} basis-2/5 font-mono`} value={k} placeholder="name" spellCheck={false} aria-label={`${f.label} name ${i + 1}`} onChange={e => setRow(i, `${e.target.value}=${v}`)} />
                      {f.mask && isSecretName(k) ? (
                        <>
                          <input className={`${field} font-mono`} type={revealed.has(`${f.name}:${i}`) ? 'text' : 'password'} value={v} placeholder="value" spellCheck={false} autoComplete="off" aria-label={`${f.label} value ${i + 1}`} onChange={e => setRow(i, `${k}=${e.target.value}`)} />
                          <button type="button" className="rounded px-1.5 py-0.5 text-[11px] text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800" onClick={() => setRevealed(s => { const n = new Set(s); const key = `${f.name}:${i}`; if (n.has(key)) n.delete(key); else n.add(key); return n; })}>{revealed.has(`${f.name}:${i}`) ? 'Hide' : 'Show'}</button>
                        </>
                      ) : (
                        <input className={`${field} font-mono`} value={v} placeholder="value" spellCheck={false} aria-label={`${f.label} value ${i + 1}`} onChange={e => setRow(i, `${k}=${e.target.value}`)} />
                      )}
                    </>
                  )
                  : <input className={`${field} font-mono`} value={v} placeholder={f.placeholder} spellCheck={false} aria-label={`${f.label} ${i + 1}`} onChange={e => setRow(i, e.target.value)} />}
                <button type="button" className="rounded p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-900 dark:hover:bg-gray-800" aria-label={`Remove ${f.label} ${i + 1}`} onClick={() => set(f.name, rows.filter((_, j) => j !== i))}><X className="size-3.5" /></button>
              </div>
            );
          })}
          <button type="button" className={buttonClass} onClick={() => set(f.name, [...rows, ''])}><Plus className="size-3" aria-hidden /> Add</button>
        </div>
      );
      labelled = false;
    } else {
      control = <input className={field} type={f.input === 'number' ? 'number' : 'text'} value={String(values[f.name] ?? '')} placeholder={f.placeholder} spellCheck={false} onChange={e => set(f.name, e.target.value)} />;
    }
    return (
      <div key={f.name} className="space-y-0.5">
        {labelled ? <label className="block space-y-0.5">{label}{control}</label> : <><div>{label}</div>{control}</>}
        {f.help && <span className="block text-[11px] text-gray-500">{f.help}</span>}
        {used && <Warn text={f.warn!} />}
      </div>
    );
  };

  return (
    <div className="space-y-3">
      {block.fields.filter(f => editorFieldVisible(f, values) && !hidden.has(f.name)).map(f => renderField(f))}
      {problem && <div role="alert" className="text-xs text-red-600 dark:text-red-400">{problem}</div>}
      {warnings.length > 0 && <div role="status" className="rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">Elevated options are set: they can give this container control over the host.</div>}
      {failure && (
        <div ref={errorRef} role="alert" className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
          <div className="font-medium">That did not work</div>
          <div className="whitespace-pre-wrap break-words text-xs">{failure}</div>
        </div>
      )}
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

