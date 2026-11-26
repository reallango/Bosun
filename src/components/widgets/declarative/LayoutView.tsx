'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Dialog } from 'radix-ui';
import { ChevronDown, ChevronRight, Loader2, X } from 'lucide-react';
import type { Block, FormField } from '@/lib/widgets/runtime/spec-v2';
import type { ViewSpec } from '@/lib/widgets/runtime/spec';
import {
  actionApplies, activeTabId, formInitial, formParams, jobHeadline, layoutRows, opensInDialog, primaryToolbarEntry, selectCurrent, selectParams, tabCount, text, visible, visibleBadges,
  type JobState, type PublicActionLike, type ViewContext,
} from '@/lib/widgets/runtime/layout';
import { Bar, Fields } from './parts';
import { fitsSize } from '@/lib/widgets/runtime/size';
import { useWidgetSize } from '@/components/dashboard/widget-size';
import { CodeBlock, EditorBlock } from './EditorBlock';
import {
  buttonClass, DIALOG_CONTENT, DIALOG_FOOTER, DIALOG_HEADER, DIALOG_OVERLAY, DIALOG_TITLE, DIALOG_WIDTH, iconButtonClass, inputClass, NOTICE_CLASS as NOTICE, primarySubmitClass,
  toolbarButtonClass,
} from './styles';

const BADGE: Record<string, string> = {
  green: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
  amber: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  red: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
  gray: 'bg-muted text-muted-foreground',
  blue: 'bg-primary/10 text-primary',
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
  submit?: (action: PublicActionLike, params: Record<string, unknown>, extra?: { origin?: unknown; savedFrom?: string }) => Promise<{ ok: boolean; error?: string }>;
  /** Call a dataset of the widget with arguments (a button of an editor, or a select that gets its options from the host). */
  loadDataset?: (dataset: string, args: Record<string, string>) => Promise<{ ok: true; data: unknown } | { ok: false; error: string }>;
  /** An editor's submit finished (screens close their dialog on success). */
  onSubmitted?: (ok: boolean) => void;
  /** Bigger text and fields, for dialogs and pages. */
  large?: boolean;
  /** A full-page screen: tabs keep the open one in the URL. */
  page?: boolean;
}

export function LayoutBlocks({ blocks, ctx, ui, groupToolbar }: { blocks: Block[]; ctx: ViewContext; ui: LayoutUi; groupToolbar?: boolean }) {
  // Blocks with `hideBelow` drop out while the widget is smaller (dialogs and pages count as the largest size).
  const { size } = useWidgetSize();
  const shown = blocks.filter(b => fitsSize(b, size) && visible(b, ctx));
  if (groupToolbar) {
    // A tab's create buttons and actions share one row above the list they belong to.
    return (
      <div className="space-y-2">
        {layoutRows(shown).map((row, i) => row.kind === 'toolbar'
          ? <Toolbar key={i} blocks={row.blocks} ctx={ctx} ui={ui} />
          : <BlockView key={i} block={row.block} ctx={ctx} ui={ui} />)}
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {shown.map((b, i) => <BlockView key={i} block={b} ctx={ctx} ui={ui} />)}
    </div>
  );
}

/** Which button of a toolbar is its one solid button (see `primaryToolbarEntry`). */
interface ToolbarLook { primaryActionId?: string; primaryDialog?: boolean }

/** The actions of a `buttons` block that this person can use in this context, in the order the block lists them. */
const toolbarActions = (block: Extract<Block, { type: 'buttons' }>, ctx: ViewContext, ui: LayoutUi): PublicActionLike[] =>
  block.actions.map(id => ui.actions.get(id)).filter((a): a is PublicActionLike => !!a && ui.allowed(a) && actionApplies(a, ctx));

/** Can a dialog-form trigger be used at all? (Its action exists, this person may run it, and it applies.) */
const dialogUsable = (block: Extract<Block, { type: 'form' | 'editor' }>, ctx: ViewContext, ui: LayoutUi): boolean =>
  block.type === 'form'
    ? (() => { const a = ui.actions.get(block.submit.action); return !!a && ui.allowed(a) && actionApplies(a, ctx); })()
    : block.submits.some(s => { const a = ui.actions.get(s.action); return !!a && ui.allowed(a) && actionApplies(a, ctx); });

/**
 * One row of a tab's toolbar: its dialog-form triggers and `buttons` blocks, all the same size and exactly one solid
 * (the first dialog trigger, else the first action that is not destructive; the rest are outlined).
 */
function Toolbar({ blocks, ctx, ui }: { blocks: Block[]; ctx: ViewContext; ui: LayoutUi }) {
  const entries: { kind: 'dialog' | 'action'; blockIndex: number; actionId?: string; destructive: boolean }[] = [];
  blocks.forEach((b, i) => {
    if (b.type === 'buttons') {
      for (const a of toolbarActions(b, ctx, ui)) entries.push({ kind: 'action', blockIndex: i, actionId: a.id, destructive: !!a.confirm?.destructive });
    } else if (opensInDialog(b) && dialogUsable(b, ctx, ui)) {
      entries.push({ kind: 'dialog', blockIndex: i, destructive: false });
    }
  });
  const at = primaryToolbarEntry(entries);
  const primary = at >= 0 ? entries[at] : null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">
      {blocks.map((b, i) => (
        <BlockView key={i} block={b} ctx={ctx} ui={ui}
          toolbar={{
            primaryActionId: primary?.kind === 'action' && primary.blockIndex === i ? primary.actionId : undefined,
            primaryDialog: primary?.kind === 'dialog' && primary.blockIndex === i,
          }} />
      ))}
    </div>
  );
}

function BlockView({ block, ctx, ui, toolbar }: { block: Block; ctx: ViewContext; ui: LayoutUi; toolbar?: ToolbarLook }) {
  switch (block.type) {
    case 'section': return <Section block={block} ctx={ctx} ui={ui} />;
    case 'kv': return <Fields fields={block.items} data={ctx} />;
    case 'text': return <p className="whitespace-pre-wrap break-words text-xs text-foreground">{text(block.text, ctx)}</p>;
    case 'notice': return <div role={block.level === 'error' ? 'alert' : 'status'} className={`rounded-md border px-2 py-1.5 text-xs ${NOTICE[block.level]}`}>{text(block.text, ctx)}</div>;
    case 'buttons': return <Buttons block={block} ctx={ctx} ui={ui} toolbar={toolbar} />;
    case 'form': return block.open === 'dialog' ? <DialogBlock block={block} ctx={ctx} ui={ui} toolbar={toolbar} /> : <Form block={block} ctx={ctx} ui={ui} />;
    case 'select': return <SelectBlock block={block} ctx={ctx} ui={ui} />;
    case 'jobProgress': return <JobProgress job={ctx.job ?? null} ui={ui} />;
    case 'tabs': return <Tabs block={block} ctx={ctx} ui={ui} />;
    case 'editor': return block.open === 'dialog' ? <DialogBlock block={block} ctx={ctx} ui={ui} toolbar={toolbar} /> : <EditorBlock block={block} ctx={ctx} ui={ui} />;
    case 'code': return <CodeBlock title={block.title} text={String(pathOf(ctx, block.value) ?? '')} filename={block.filename} />;
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
  return ui.page
    ? <PageTabs block={block} ctx={ctx} ui={ui} />
    : <MemoryTabs block={block} ctx={ctx} ui={ui} />;
}

/** A page screen keeps its tab in `?tab=<id>` (replace, so Back leaves the page rather than walking the tabs). */
function PageTabs({ block, ctx, ui }: { block: Extract<Block, { type: 'tabs' }>; ctx: ViewContext; ui: LayoutUi }) {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const active = activeTabId(block.tabs, search.get('tab'));
  const select = (id: string) => {
    const params = new URLSearchParams(search.toString());
    params.set('tab', id);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };
  return <TabsView block={block} ctx={ctx} ui={ui} active={active} onSelect={select} />;
}

/** A dialog screen or a widget on a dashboard keeps the open tab in memory, as it always has. */
function MemoryTabs({ block, ctx, ui }: { block: Extract<Block, { type: 'tabs' }>; ctx: ViewContext; ui: LayoutUi }) {
  const [active, setActive] = useState(block.tabs[0]?.id);
  return <TabsView block={block} ctx={ctx} ui={ui} active={active} onSelect={setActive} />;
}

function TabsView({ block, ctx, ui, active, onSelect }: {
  block: Extract<Block, { type: 'tabs' }>; ctx: ViewContext; ui: LayoutUi; active: string | undefined; onSelect: (id: string) => void;
}) {
  const base = useId().replace(/:/g, '');
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const tab = block.tabs.find(t => t.id === active) ?? block.tabs[0];
  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, i: number) => {
    const last = block.tabs.length - 1;
    const next = e.key === 'ArrowRight' ? (i === last ? 0 : i + 1)
      : e.key === 'ArrowLeft' ? (i === 0 ? last : i - 1)
      : e.key === 'Home' ? 0
      : e.key === 'End' ? last
      : null;
    if (next === null) return;
    e.preventDefault();
    onSelect(block.tabs[next].id);
    refs.current[next]?.focus();
  };
  return (
    <div className="space-y-3">
      <div role="tablist" className="flex flex-nowrap gap-1 overflow-x-auto border-b border-border sm:flex-wrap sm:overflow-visible">
        {block.tabs.map((t, i) => {
          const selected = t.id === tab.id;
          const count = tabCount(t.count, ctx);
          return (
            <button key={t.id} ref={el => { refs.current[i] = el; }} type="button" role="tab" id={`${base}-tab-${t.id}`}
              aria-selected={selected} aria-controls={`${base}-panel-${t.id}`} tabIndex={selected ? 0 : -1} onClick={() => onSelect(t.id)}
              onKeyDown={e => onKeyDown(e, i)}
              className={`-mb-px inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-t-md border-b-2 px-3 py-1.5 ${ui.large ? 'text-sm' : 'text-xs'} font-medium ${selected ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>
              {t.label}
              {count !== null && <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${selected ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}`}>{count}</span>}
            </button>
          );
        })}
      </div>
      {/* keyed by tab: the editors of two tabs must not share their state */}
      <div role="tabpanel" id={`${base}-panel-${tab.id}`} aria-labelledby={`${base}-tab-${tab.id}`} tabIndex={0} key={tab.id}>
        <LayoutBlocks blocks={tab.blocks} ctx={ctx} ui={ui} groupToolbar />
      </div>
    </div>
  );
}

function Section({ block, ctx, ui }: { block: Extract<Block, { type: 'section' }>; ctx: ViewContext; ui: LayoutUi }) {
  const [open, setOpen] = useState(block.defaultOpen);
  const badges = visibleBadges(block.badges, ctx);
  const summary = block.summary ? text(block.summary, ctx) : '';
  return (
    <section className="rounded-lg border border-border">
      <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-muted">
        {open ? <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden /> : <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />}
        <span className="text-xs font-semibold">{block.title}</span>
        {badges.map((b, i) => <span key={i} className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${BADGE[b.color]}`}>{b.text}</span>)}
        {!open && summary && <span className="ml-auto min-w-0 truncate text-xs text-muted-foreground">{summary}</span>}
      </button>
      {open && <div className="border-t border-border p-2"><LayoutBlocks blocks={block.blocks} ctx={ctx} ui={ui} /></div>}
    </section>
  );
}

function Buttons({ block, ctx, ui, toolbar }: { block: Extract<Block, { type: 'buttons' }>; ctx: ViewContext; ui: LayoutUi; toolbar?: ToolbarLook }) {
  const list = toolbarActions(block, ctx, ui);
  if (!list.length) return null;
  const size = ui.large ? 'large' : 'small';
  return (
    <div className="flex flex-wrap gap-1.5">
      {list.map(a => {
        const params: Record<string, unknown> = {};
        for (const [n, p] of Object.entries(a.params ?? {})) if (p.default !== undefined) params[n] = p.default;
        const needsInput = Object.keys(a.params ?? {}).some(n => params[n] === undefined);
        const cls = toolbar
          ? toolbarButtonClass(size, toolbar.primaryActionId === a.id ? 'primary' : a.confirm?.destructive ? 'destructive' : 'outline')
          : buttonClass;
        return (
          <button key={a.id} type="button" className={cls} disabled={ui.busy !== null || needsInput || (a.job && (ctx.job?.status === 'running'))}
            title={needsInput ? 'This action needs a value: use its form' : a.description} onClick={() => ui.onAction(a, params)}>
            {ui.busy === a.id && <Loader2 className="size-3 animate-spin motion-reduce:animate-none" aria-hidden />}{a.label}
          </button>
        );
      })}
    </div>
  );
}

/** A form or editor block that shows as a button and opens in a dialog (spec key `"open": "dialog"`). */
function DialogBlock({ block, ctx, ui, toolbar }: { block: Extract<Block, { type: 'form' | 'editor' }>; ctx: ViewContext; ui: LayoutUi; toolbar?: ToolbarLook }) {
  const [open, setOpen] = useState(false);
  const usable = dialogUsable(block, ctx, ui);
  if (!usable) return null;
  const title = block.type === 'form' && block.title ? block.title : block.label!;
  const close = () => setOpen(false);
  const dialogUi: LayoutUi = { ...ui, onSubmitted: ok => { if (ok) close(); ui.onSubmitted?.(ok); } };
  const triggerClass = toolbar
    ? toolbarButtonClass(ui.large ? 'large' : 'small', toolbar.primaryDialog ? 'primary' : 'outline')
    : primarySubmitClass;
  return (
    <>
      <button type="button" className={triggerClass} onClick={() => setOpen(true)}>{block.label}</button>
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className={DIALOG_OVERLAY} />
          <Dialog.Content className={`${DIALOG_CONTENT} ${DIALOG_WIDTH.md}`} aria-describedby={undefined}>
            <div className={DIALOG_HEADER}>
              <Dialog.Title className={DIALOG_TITLE}>{title}</Dialog.Title>
              <Dialog.Close asChild><button type="button" className={iconButtonClass} aria-label="Close"><X className="size-4" /></button></Dialog.Close>
            </div>
            {block.type === 'form'
              ? <Form block={block} ctx={ctx} ui={ui} onClose={close} />
              : <EditorBlock block={block} ctx={ctx} ui={dialogUi} dialog />}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}

function Form({ block, ctx, ui, onClose }: { block: Extract<Block, { type: 'form' }>; ctx: ViewContext; ui: LayoutUi; onClose?: () => void }) {
  const initial = formInitial(block.fields, ctx);
  const key = JSON.stringify(initial);
  const [values, setValues] = useState<Record<string, string>>(initial);
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [problem, setProblem] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
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
    setFailure(null);
    if (onClose && ui.submit) {
      setSending(true);
      void ui.submit(action, params)
        .then(r => { if (!r.ok) { setFailure(r.error ?? 'That did not work'); return; } ui.onSubmitted?.(true); onClose(); })
        .finally(() => setSending(false));
      return;
    }
    ui.onAction(action, params);
  };
  const set = (f: FormField, v: string) => { setTouched(t => new Set(t).add(f.name)); setValues(s => ({ ...s, [f.name]: v })); };
  const fields = (
    <>
      {block.fields.map(f => (
        <label key={f.name} className="block space-y-0.5">
          <span className="text-xs text-muted-foreground">{f.label}</span>
          {f.input === 'select'
            ? <select className={inputClass} value={values[f.name] ?? ''} onChange={e => set(f, e.target.value)}>{f.options?.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
            : <input className={inputClass} type={f.input === 'number' ? 'number' : 'text'} value={values[f.name] ?? ''} placeholder={f.placeholder} onChange={e => set(f, e.target.value)} />}
          {f.help && <span className="block text-[11px] text-muted-foreground">{f.help}</span>}
        </label>
      ))}
      {problem && <div role="alert" className="text-xs text-destructive">{problem}</div>}
      {failure && <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">{failure}</div>}
    </>
  );
  const submitButton = (
    <button type="submit" className={onClose ? primarySubmitClass : buttonClass} disabled={ui.busy !== null || sending || (action.job && ctx.job?.status === 'running')}>
      {(sending || ui.busy === action.id) && <Loader2 className="size-3 animate-spin motion-reduce:animate-none" aria-hidden />}{block.submit.label}
    </button>
  );
  if (onClose) {
    return (
      <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 space-y-2 overflow-auto pr-1">{fields}</div>
        <div className={DIALOG_FOOTER}>{submitButton}</div>
      </form>
    );
  }
  return (
    <form onSubmit={submit} className="space-y-2">
      {block.title && <div className="text-xs font-semibold">{block.title}</div>}
      {fields}
      {submitButton}
    </form>
  );
}

function SelectBlock({ block, ctx, ui }: { block: Extract<Block, { type: 'select' }>; ctx: ViewContext; ui: LayoutUi }) {
  const action = ui.actions.get(block.action);
  if (!action || !ui.allowed(action) || !actionApplies(action, ctx)) return null;
  const current = selectCurrent(block, ctx);
  return (
    <label className="flex items-center justify-between gap-2 text-xs">
      <span className="text-muted-foreground">{block.label}</span>
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
  const tone = job.status === 'success' ? NOTICE.info : running ? 'border-border' : NOTICE.error;
  const steps = job.steps.slice(-5);
  return (
    <div className={`space-y-1.5 rounded-md border p-2 text-xs ${tone}`} role="status" aria-live="polite">
      <div className="flex items-center gap-2">
        {running && <Loader2 className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />}
        <span className="min-w-0 flex-1 truncate font-medium">{jobHeadline(job, action?.label)}</span>
        {running && action && ui.allowed(action) && <button type="button" className={buttonClass} onClick={ui.onCancelJob}>Cancel</button>}
        {!running && <button type="button" className={buttonClass} onClick={() => setDismissed(job.id)}>Dismiss</button>}
      </div>
      {running && job.percent !== null && <Bar value={job.percent} color="bg-primary" />}
      {steps.length > 0 && (
        <ol className="space-y-0.5 text-[11px] text-muted-foreground">
          {steps.map((s, i) => <li key={i} className={i === steps.length - 1 && running ? 'font-medium text-foreground' : ''}>{s}</li>)}
        </ol>
      )}
    </div>
  );
}
