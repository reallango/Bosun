'use client';

import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Dialog } from 'radix-ui';
import { ChevronDown, ChevronRight, Loader2, X } from 'lucide-react';
import type { Block, FormField, InfoItem } from '@/lib/widgets/runtime/spec-v2';
import { fillTemplate, type ViewSpec } from '@/lib/widgets/runtime/spec';
import {
  actionApplies, activeTabId, formInitial, formParams, jobHeadline, layoutRows, opensInDialog, primaryToolbarEntry, selectCurrent, selectParams, tabCount, text, visible, visibleBadges,
  type JobState, type PublicActionLike, type ViewContext,
} from '@/lib/widgets/runtime/layout';
import { Bar, Fields, Sparkline, type StatToneName } from './parts';
import { fitsSize, type WidgetSize } from '@/lib/widgets/runtime/size';
import { countRows, statTone, withUnit } from '@/lib/widgets/runtime/stat';
import { thresholdTone } from '@/lib/widgets/runtime/thresholds';
import { formatStatValue, formatValue } from '@/lib/widgets/runtime/number-format';
import { meterRowView, visibleMeterRows } from '@/lib/widgets/runtime/meters';
import { pickAdaptive, visibleInfo } from '@/lib/widgets/runtime/adaptive';
import { gaugeLabelFontSize, labelFontSize, fitGaugeValues, fitTileValues, longestValueLength, unitOnOwnLine, type BlockSize, type MinItemWidth, type ValueFit, type ValueText } from '@/lib/widgets/runtime/sizing';
import { gaugeGeometry, gaugeItemsFromRows, gaugeStroke, GAUGE_VIEWBOX, type GaugeItem } from '@/lib/widgets/runtime/gauges';
import { useWidgetSize } from '@/components/dashboard/widget-size';
import { useWidgetDensity, useWidgetFill } from './fill';
import { CodeBlock, EditorBlock } from './EditorBlock';
import { ItemGrid } from './ItemGrid';
import { CredentialsBlock } from './CredentialsBlock';
import {
  buttonClass, DIALOG_CONTENT, DIALOG_FOOTER, DIALOG_HEADER, DIALOG_OVERLAY, DIALOG_TITLE, DIALOG_WIDTH, FILL_CARD, FILL_CARD_COMPACT, FILL_GAUGE_CARD,
  FILL_GAUGE_CARD_COMPACT, FILL_GAUGE_LABEL, FILL_GAUGE_VALUE, FILL_GRID_COLUMNS, FILL_GRID_MIN, FILL_LABEL, FILL_SUB, FILL_VALUE,
  FILL_VALUE_COMPACT, METER_GRID, METER_GRID_CELL, METER_GRID_TRACK, METER_LIST, METER_LIST_COMPACT, METER_RING, METER_RING_COMPACT, METER_RING_TRACK, METER_ROW, METER_SUB, METER_VALUE,
  STAT_GRID_COLUMNS,
  iconButtonClass, inputClass, NOTICE_CLASS as NOTICE, primarySubmitClass, toolbarButtonClass,
} from './styles';

const BADGE: Record<string, string> = {
  green: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
  amber: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  red: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
  gray: 'bg-muted text-muted-foreground',
  blue: 'bg-primary/10 text-primary',
};
const FINISHED_JOB_SHOWN_MS = 10 * 60 * 1000;

/** A stat tile's `tab` switches the tabs around it; null outside a tab group (the tile then stays static). */
const TabSelectContext = createContext<((id: string) => void) | null>(null);

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
  /** The entries of a credential kind (a `credentials` block), their writes, and the server choices. */
  credentials?: {
    load: (kind: string) => Promise<import('@/lib/widgets/runtime/credential-view').CredentialResult<import('@/lib/widgets/runtime/credential-view').CredentialKindView>>;
    save: (kind: string, entry: import('@/lib/widgets/runtime/credential-view').CredentialWriteView) => Promise<import('@/lib/widgets/runtime/credential-view').CredentialResult>;
    remove: (kind: string, id: string) => Promise<import('@/lib/widgets/runtime/credential-view').CredentialResult>;
    servers: () => Promise<{ id: string; name: string }[]>;
  };
  /** Options of a select bound to a credential kind: "Automatic" plus the entries the caller may see. */
  credentialOptions?: (kind: string) => Promise<{ value: string; label: string }[]>;
}

/**
 * Blocks that take the room the other blocks leave inside a widget: a grid of numbers, a meter list, and a list, table
 * or chart. A text line, a notice, a key/value list or a toolbar keeps its natural height instead.
 */
const fillsBody = (b: Block): boolean =>
  b.type === 'stat' || b.type === 'gauges' || b.type === 'meters'
  || (b.type === 'view' && (b.view.type === 'list' || b.view.type === 'table' || b.view.type === 'chart'));

export function LayoutBlocks({ blocks, ctx, ui, groupToolbar }: { blocks: Block[]; ctx: ViewContext; ui: LayoutUi; groupToolbar?: boolean }) {
  // Blocks with `hideBelow` drop out while the widget is smaller (dialogs and pages count as the largest size).
  const { size } = useWidgetSize();
  const fill = useWidgetFill();
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
  // Inside a widget the blocks share the whole body; a grid of numbers or a list takes the space the others leave.
  return (
    <div className={fill ? 'flex h-full min-h-0 flex-col gap-2' : 'space-y-2'}>
      {shown.map((b, i) => (
        <div key={i} className={fill && fillsBody(b) ? 'min-h-0 flex-1 overflow-hidden' : fill && b.type === 'info' ? 'mt-auto shrink-0' : undefined}>
          <BlockView block={b} ctx={ctx} ui={ui} />
        </div>
      ))}
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
    case 'stat': return <StatBlock block={block} ctx={ctx} />;
    case 'gauges': return <GaugeBlock block={block} ctx={ctx} />;
    case 'meters': return <MetersBlock block={block} ctx={ctx} />;
    case 'info': return <InfoLine items={block.items} ctx={ctx} />;
    case 'text': return <TextBlock block={block} ctx={ctx} />;
    case 'notice': return <div role={block.level === 'error' ? 'alert' : 'status'} className={`rounded-md border px-2 py-1.5 text-xs ${NOTICE[block.level]}`}>{text(block.text, ctx)}</div>;
    case 'buttons': return <Buttons block={block} ctx={ctx} ui={ui} toolbar={toolbar} />;
    case 'form': return block.open === 'dialog' ? <DialogBlock block={block} ctx={ctx} ui={ui} toolbar={toolbar} /> : <Form block={block} ctx={ctx} ui={ui} />;
    case 'select': return <SelectBlock block={block} ctx={ctx} ui={ui} />;
    case 'jobProgress': return <JobProgress job={ctx.job ?? null} ui={ui} />;
    case 'credentials': return <CredentialsBlock block={block} ui={ui} />;
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
        <TabSelectContext.Provider value={onSelect}>
          <LayoutBlocks blocks={tab.blocks} ctx={ctx} ui={ui} groupToolbar />
        </TabSelectContext.Provider>
      </div>
    </div>
  );
}

const STAT_COLUMNS: Record<string, string> = { xs: 'grid-cols-1', sm: 'grid-cols-2', md: 'grid-cols-3', lg: 'grid-cols-4' };
const STAT_TONE_CLASS: Record<StatToneName, string> = {
  danger: 'text-destructive',
  warning: 'text-warning',
  success: 'text-success',
};
const STAT_TONE_STROKE: Record<StatToneName, string> = {
  danger: 'stroke-destructive',
  warning: 'stroke-warning',
  success: 'stroke-success',
};
const STAT_TONE_BAR: Record<StatToneName, string> = {
  danger: 'bg-destructive',
  warning: 'bg-warning',
  success: 'bg-success',
};
const STAT_CARD = 'flex min-w-0 flex-col gap-0.5 rounded-lg border border-border bg-card p-3 text-left';
const GAUGE_CARD = 'flex min-w-0 flex-col items-center gap-1 rounded-lg border border-border bg-card p-3 text-center';

/** Below this measured widget body height (about three grid rows) tiles and gauges switch to their compact layout. */
const COMPACT_HEIGHT = 160;
/** A tile card shorter than this (its measured content box) drops its trend and sub, keeping the label, value and bar. */
const CARD_COMPACT_HEIGHT = 80;

/**
 * The grid class of a stat or gauge block: a fixed count, the auto-fit minimum of `minItemWidth`, or the size class outside
 * a widget. Inside a widget the measured balanced arrangement overrides the auto-fit template (see ItemGrid).
 */
function itemGridClass(fill: boolean, widgetSize: WidgetSize, block: { columns?: number; minItemWidth?: MinItemWidth }): string {
  if (block.columns) return fill ? FILL_GRID_COLUMNS[block.columns] : STAT_GRID_COLUMNS[block.columns];
  if (fill) return FILL_GRID_MIN[block.minItemWidth ?? 'md'];
  return `grid gap-2 ${STAT_COLUMNS[widgetSize] ?? STAT_COLUMNS.lg}`;
}

/** A block's `size` outside a widget (no container to scale with): the reading size of its number and label. */
function tileValueClass(blockSize: BlockSize, widgetSize: WidgetSize): string {
  if (blockSize === 'sm') return 'text-lg';
  if (blockSize === 'lg') return 'text-3xl';
  return widgetSize === 'xs' ? 'text-xl' : 'text-2xl';
}

function tileLabelClass(blockSize: BlockSize): string {
  const textSize = blockSize === 'sm' ? 'text-[11px]' : blockSize === 'lg' ? 'text-sm' : 'text-xs';
  return `truncate ${textSize} text-muted-foreground`;
}

/** The value inside a ring outside a filling widget. */
function gaugeValueClass(blockSize: BlockSize): string {
  if (blockSize === 'sm') return 'text-lg';
  if (blockSize === 'lg') return 'text-3xl';
  return 'text-xl';
}

/**
 * The content box of a block's first item (a tile's card, or a gauge's ring wrapper), measured so the fit helper can
 * decide when a value's unit must move to its own line. Every item in a block shares the same grid cell, so one
 * measurement serves them all.
 */
function useCardSize() {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const elRef = useRef<HTMLElement | null>(null);
  const ref = useCallback((el: HTMLElement | null) => {
    elRef.current = el;
  }, []);
  useEffect(() => {
    const el = elRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(entries => {
      const box = entries[0]?.contentRect;
      if (!box) return;
      const width = Math.round(box.width * 10) / 10;
      const height = Math.round(box.height * 10) / 10;
      setSize(prev => (prev.width === width && prev.height === height ? prev : { width, height }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, width: size.width, height: size.height };
}

/** A value in a filling card: one line normally, or the number and a smaller unit line when the fit says to split. */
function ValueLines({ number, unit, fit, className, tone }: {
  number: string; unit?: string; fit: ValueFit; className: string; tone: string;
}) {
  if (!fit.split) {
    return <div className={`${className} ${tone}`} style={{ fontSize: fit.fontSize }}>{withUnit(number, unit)}</div>;
  }
  const attached = unit?.startsWith('%') && !fit.splitPercent ? unit : undefined;
  return (
    <div className={`${className} ${tone} flex flex-col`} style={{ fontSize: fit.fontSize }}>
      <span className="block">{withUnit(number, attached)}</span>
      {unitOnOwnLine(unit, fit) && <span className="block" style={{ fontSize: fit.unitFontSize }}>{unit}</span>}
    </div>
  );
}

/** The value of one info-line pair: its template, written in its `format` when it names one. */
const infoValue = (item: InfoItem, ctx: ViewContext): string => {
  const raw = text(item.value, ctx);
  return item.format ? formatValue(raw, item.format) : raw;
};

/** The footer of a `stat` or `gauges` block: one muted line of label/value pairs, pinned under the block. */
function InfoLine({ items, ctx }: { items: InfoItem[]; ctx: ViewContext }) {
  const shown = visibleInfo(items, ctx);
  if (!shown.length) return null;
  const title = shown.map(i => `${text(i.label, ctx)} ${infoValue(i, ctx)}`.trim()).join(' · ');
  return (
    <div className="mt-auto min-w-0 shrink-0 overflow-hidden text-ellipsis whitespace-nowrap text-[11px] leading-tight text-muted-foreground" title={title}>
      {shown.map((item, i) => (
        <span key={i}>
          {i > 0 && <span aria-hidden="true"> · </span>}
          <span>{text(item.label, ctx)}</span> <span className="text-foreground">{infoValue(item, ctx)}</span>
        </span>
      ))}
    </div>
  );
}

/** A responsive grid of number cards; a card with a `tab` switches to that tab when it is inside a tab group. */
function StatBlock({ block, ctx }: { block: Extract<Block, { type: 'stat' }>; ctx: ViewContext }) {
  const { size: widgetSize, height } = useWidgetSize();
  const fill = useWidgetFill();
  const density = useWidgetDensity();
  const card = useCardSize();
  const compact = fill && (density === 'compact' || (height > 0 && height < COMPACT_HEIGHT));
  const shortCard = fill && card.height > 0 && card.height < CARD_COMPACT_HEIGHT;
  // A short card keeps its label, value and sub, but drops the trend line and uses the tight padding.
  const tight = compact || shortCard;
  const selectTab = useContext(TabSelectContext);
  const blockSize = block.size ?? 'md';
  const items = block.items.map(item => pickAdaptive(item, ctx)).filter((item): item is NonNullable<typeof item> => item !== null);
  const shown = items.map(item => {
    const raw = item.count ? String(countRows(item.count, ctx)) : text(item.value ?? '', ctx);
    return { item, ...formatStatValue(raw, item.format, item.unit, item.decimals) };
  });
  // Every item in the block takes the same size and the same split decision, chosen from its widest value, so
  // neighbours stay balanced.
  const fit = fitTileValues(shown.map(({ number, unit }) => ({ number, unit })), {
    size: blockSize, compact: tight, width: card.width, height: card.height,
  });
  const valueChars = longestValueLength(shown.map(({ number, unit }) => withUnit(number, unit)));
  const grid = (
    <ItemGrid fill={fill} columns={block.columns} minItemWidth={block.minItemWidth} kind="stat" count={shown.length}
      valueChars={valueChars} compact={tight} className={itemGridClass(fill, widgetSize, block)}>
      {shown.map(({ item, number, unit }, i) => {
        const numeric = item.count ? countRows(item.count, ctx) : Number(fillTemplate(item.value ?? '', ctx));
        const tone = statTone(item.tone, ctx) ?? thresholdTone(numeric, item.thresholds);
        const bar = item.bar ? Number(fillTemplate(item.bar, ctx)) : NaN;
        const cardClass = fill ? (tight ? FILL_CARD_COMPACT : FILL_CARD) : STAT_CARD;
        const valueTone = tone ? STAT_TONE_CLASS[tone] : item.emphasis === 'muted' ? 'text-muted-foreground' : 'text-foreground';
        const valueSize = fill ? (tight ? FILL_VALUE_COMPACT : FILL_VALUE) : tileValueClass(blockSize, widgetSize);
        const content = (
          <>
            <div className={fill ? FILL_LABEL : tileLabelClass(blockSize)} style={fill ? { fontSize: labelFontSize(blockSize) } : undefined}>{item.label}</div>
            {fill
              ? <ValueLines number={number} unit={unit} fit={fit} className={valueSize} tone={valueTone} />
              : <div className={`${valueSize} font-semibold tabular-nums ${valueTone}`}>{withUnit(number, unit)}</div>}
            {Number.isFinite(bar) && <Bar value={bar} tone={tone} />}
            {/* A three-row tile has no room for a trend line; the number and bar are the parts that must stay. */}
            {!tight && item.trend && <Sparkline trend={item.trend} tone={tone} />}
            {!compact && item.sub && <div className={fill ? FILL_SUB : 'truncate text-xs text-muted-foreground'}>{text(item.sub, ctx)}</div>}
          </>
        );
        return item.tab && selectTab
          ? <button key={i} type="button" ref={i === 0 ? card.ref : undefined} onClick={() => selectTab(item.tab!)} className={`${cardClass} hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`}>{content}</button>
          : <div key={i} ref={i === 0 ? card.ref : undefined} className={cardClass}>{content}</div>;
      })}
    </ItemGrid>
  );
  if (!block.footer?.length) return grid;
  return (
    <div className={fill ? 'flex h-full min-h-0 flex-col gap-1' : 'space-y-1'}>
      <div className={fill ? 'min-h-0 flex-1' : undefined}>{grid}</div>
      <InfoLine items={block.footer} ctx={ctx} />
    </div>
  );
}

/** A ring gauge: the value in the middle of a circle that fills as it approaches `max`. */
function Gauge({ item, ctx, fill, compact, fit, blockSize, thickness, cardRef }: {
  item: GaugeItem; ctx: ViewContext; fill: boolean; compact: boolean; fit: ValueFit; blockSize: BlockSize;
  thickness?: GaugeItem['thickness']; cardRef?: (el: HTMLElement | null) => void;
}) {
  const value = text(item.value, ctx);
  const numeric = Number(fillTemplate(item.value, ctx));
  const tone = thresholdTone(numeric, item.thresholds);
  const stroke = gaugeStroke(item.thickness ?? thickness);
  const geometry = gaugeGeometry(numeric, item.max ?? 100, GAUGE_VIEWBOX, stroke);
  const { number, unit } = formatStatValue(value, item.format, item.unit, item.decimals);
  const valueText = withUnit(number, unit);
  const label = `${item.label}: ${valueText}`;
  const valueTone = tone ? STAT_TONE_CLASS[tone] : item.emphasis === 'muted' ? 'text-muted-foreground' : 'text-foreground';
  // A split value already has two lines; the in-ring label would make three, so it moves under the ring instead.
  const split = fill && fit.split;
  return (
    <div className={fill ? (compact ? FILL_GAUGE_CARD_COMPACT : FILL_GAUGE_CARD) : GAUGE_CARD}>
      {/* A short card puts the label inside the ring, under the value, so the ring can use the whole height. */}
      {!compact && <div className={fill ? FILL_LABEL : tileLabelClass(blockSize)} style={fill ? { fontSize: labelFontSize(blockSize) } : undefined}>{item.label}</div>}
      <div ref={cardRef} title={label} className={fill ? 'relative min-h-0 w-full flex-1 [container-type:size]' : 'relative mx-auto aspect-square w-full max-w-[9rem]'}>
        <svg viewBox={`0 0 ${GAUGE_VIEWBOX} ${GAUGE_VIEWBOX}`} preserveAspectRatio="xMidYMid meet" className="size-full" role="img" aria-label={label}>
          <circle cx={geometry.cx} cy={geometry.cy} r={geometry.r} fill="none" strokeWidth={stroke} className="stroke-muted" />
          <circle cx={geometry.cx} cy={geometry.cy} r={geometry.r} fill="none" strokeWidth={stroke} strokeLinecap="round"
            strokeDasharray={geometry.circumference} strokeDashoffset={geometry.dashOffset} transform={`rotate(-90 ${geometry.cx} ${geometry.cy})`}
            className={tone ? STAT_TONE_STROKE[tone] : 'stroke-primary'} />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-0.5 overflow-hidden text-center leading-none" aria-hidden="true">
          {fill
            ? <ValueLines number={number} unit={unit} fit={fit} className={FILL_GAUGE_VALUE} tone={valueTone} />
            : <span className={`${gaugeValueClass(blockSize)} font-semibold tabular-nums ${valueTone}`}>{valueText}</span>}
          {compact && !split && <span className={FILL_GAUGE_LABEL} style={fill ? { fontSize: gaugeLabelFontSize(blockSize) } : undefined}>{item.label}</span>}
        </div>
      </div>
      {compact && split && <div className={`${FILL_GAUGE_LABEL} w-full shrink-0`} style={{ fontSize: gaugeLabelFontSize(blockSize) }}>{item.label}</div>}
      {!compact && item.sub && <div className={fill ? FILL_SUB : 'truncate text-xs text-muted-foreground'}>{text(item.sub, ctx)}</div>}
    </div>
  );
}

function GaugeBlock({ block, ctx }: { block: Extract<Block, { type: 'gauges' }>; ctx: ViewContext }) {
  const { size: widgetSize, height } = useWidgetSize();
  const fill = useWidgetFill();
  const density = useWidgetDensity();
  const compact = fill && (density === 'compact' || (height > 0 && height < COMPACT_HEIGHT));
  const blockSize = block.size ?? 'md';
  const card = useCardSize();
  // A block either lists its rings, or names a data list and draws one ring per row.
  const items = block.path
    ? (block.item ? gaugeItemsFromRows(block.item, /^(datasets|context)\./.test(block.path) ? pathOf(ctx, block.path) : pathOf(ctx.data, block.path)) : [])
    : (block.items ?? []).map(item => pickAdaptive(item, ctx)).filter((item): item is NonNullable<typeof item> => item !== null);
  if (!items.length) return <div className="py-4 text-center text-xs text-muted-foreground">{block.empty || 'Nothing to show'}</div>;
  const values: ValueText[] = items.map(item => {
    const value = text(item.value, ctx);
    return formatStatValue(value, item.format, item.unit, item.decimals);
  });
  // One size for the block, sized for its thickest ring so a mixed `thickness` still shares it.
  const stroke = Math.max(...items.map(item => gaugeStroke(item.thickness ?? block.thickness)));
  const fit = fitGaugeValues(values, { size: blockSize, stroke, width: card.width, height: card.height });
  const valueChars = longestValueLength(values.map(value => withUnit(value.number, value.unit)));
  const grid = (
    <ItemGrid fill={fill} columns={block.columns} minItemWidth={block.minItemWidth} kind="gauges" count={items.length}
      valueChars={valueChars} compact={compact} className={itemGridClass(fill, widgetSize, block)}>
      {items.map((item, i) => (
        <Gauge key={i} item={item} ctx={ctx} fill={fill} compact={compact} fit={fit} blockSize={blockSize} thickness={block.thickness}
          cardRef={fill && i === 0 ? card.ref : undefined} />
      ))}
    </ItemGrid>
  );
  if (!block.footer?.length) return grid;
  return (
    <div className={fill ? 'flex h-full min-h-0 flex-col gap-1' : 'space-y-1'}>
      <div className={fill ? 'min-h-0 flex-1' : undefined}>{grid}</div>
      <InfoLine items={block.footer} ctx={ctx} />
    </div>
  );
}

/** A small ring for a meter row: the row's share, drawn at a fixed size so a list of them stays aligned. */
function MeterRing({ pct, tone, label, compact }: { pct: number; tone: ReturnType<typeof thresholdTone>; label: string; compact: boolean }) {
  const stroke = 12;
  const geometry = gaugeGeometry(pct, 100, GAUGE_VIEWBOX, stroke);
  return (
    <span className={compact ? METER_RING_COMPACT : METER_RING} title={label}>
      <svg viewBox={`0 0 ${GAUGE_VIEWBOX} ${GAUGE_VIEWBOX}`} preserveAspectRatio="xMidYMid meet" className="size-full" role="img" aria-label={label}>
        <circle cx={geometry.cx} cy={geometry.cy} r={geometry.r} fill="none" strokeWidth={stroke} className={METER_RING_TRACK} />
        <circle cx={geometry.cx} cy={geometry.cy} r={geometry.r} fill="none" strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={geometry.circumference} strokeDashoffset={geometry.dashOffset} transform={`rotate(-90 ${geometry.cx} ${geometry.cy})`}
          className={tone ? STAT_TONE_STROKE[tone] : 'stroke-primary'} />
      </svg>
    </span>
  );
}

/**
 * A compact list of one bar or small ring per row of a data list (mounts, GPUs, interfaces). The block names the list and
 * one template per row field, so a widget never needs code for its own list.
 */
function MetersBlock({ block, ctx }: { block: Extract<Block, { type: 'meters' }>; ctx: ViewContext }) {
  const { height } = useWidgetSize();
  const fill = useWidgetFill();
  const density = useWidgetDensity();
  const compact = fill && (density === 'compact' || (height > 0 && height < COMPACT_HEIGHT));
  const source = block.path ? (/^(datasets|context)\./.test(block.path) ? pathOf(ctx, block.path) : pathOf(ctx.data, block.path)) : ctx.data;
  const rows = visibleMeterRows(block.item, source);
  if (!rows.length) return <div className="py-4 text-center text-xs text-muted-foreground">{block.empty || 'Nothing to show'}</div>;
  const views = rows.map(row => meterRowView(block.item, row));
  const ring = block.shape === 'ring';
  // A grid of many small meters (one per CPU core): a thin vertical bar with its label under it, in as many columns as fit.
  if (fill && block.layout === 'grid') {
    return (
      <div className="h-full min-h-0 [container-type:size]">
        <ul className={METER_GRID}>
          {views.map((v, i) => (
            <li key={i} className={METER_GRID_CELL} title={`${v.label}: ${v.valueText}`}>
              <div className={METER_GRID_TRACK}>
                <div className={`w-full rounded-sm ${v.tone ? STAT_TONE_BAR[v.tone] : v.emphasis === 'muted' ? 'bg-muted-foreground' : 'bg-primary'}`}
                  style={{ height: `${v.pct}%` }} />
              </div>
              <span className="w-full truncate text-center tabular-nums text-muted-foreground" style={{ fontSize: 'clamp(0.55rem, 6cqh, 0.8rem)' }}>{v.label}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  // Rows scale their bar thickness and text a little with the room the widget leaves, within a readable range.
  const rowFont = fill ? { fontSize: 'clamp(0.7rem, max(3cqw, 6cqh), 0.95rem)' } : undefined;
  const subFont = fill ? { fontSize: 'clamp(0.6rem, 4cqh, 0.8rem)' } : undefined;
  const barHeight = fill ? '[height:clamp(0.25rem,7cqh,1.5rem)]' : undefined;
  return (
    <div className={fill ? 'h-full min-h-0 [container-type:size]' : undefined}>
      <ul className={`${fill ? (compact ? METER_LIST_COMPACT : METER_LIST) : 'space-y-2'} ${fill ? 'h-full' : ''}`}>
        {views.map((v, i) => {
          const toneClass = v.tone ? STAT_TONE_CLASS[v.tone] : v.emphasis === 'muted' ? 'text-muted-foreground' : 'text-foreground';
          return (
            <li key={i} className={METER_ROW}>
              {ring && <MeterRing pct={v.pct} tone={v.tone} label={`${v.label}: ${v.valueText}`} compact={compact} />}
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-foreground" style={rowFont}>{v.label}</span>
                  <span className={`${METER_VALUE} ${toneClass}`} style={rowFont}>{v.valueText}</span>
                </div>
                {!ring && <Bar value={v.pct} tone={v.tone} className={barHeight} />}
                {!compact && v.sub && <div className={METER_SUB} style={subFont}>{v.sub}</div>}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** A line of text. A short widget keeps it to one line (truncated), so it cannot push the tiles out of the body. */
function TextBlock({ block, ctx }: { block: Extract<Block, { type: 'text' }>; ctx: ViewContext }) {
  const { height } = useWidgetSize();
  const fill = useWidgetFill();
  const short = fill && height > 0 && height < COMPACT_HEIGHT;
  return (
    <p className={short
      ? 'min-w-0 shrink-0 truncate text-xs text-foreground'
      : 'whitespace-pre-wrap break-words text-xs text-foreground'}>
      {text(block.text, ctx)}
    </p>
  );
}

function Section({ block, ctx, ui }: { block: Extract<Block, { type: 'section' }>; ctx: ViewContext; ui: LayoutUi }) {
  const [open, setOpen] = useState(block.defaultOpen);
  const badges = visibleBadges(block.badges ?? [], ctx);
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
