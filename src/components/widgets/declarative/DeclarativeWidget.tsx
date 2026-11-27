'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronDown, ChevronUp, Ellipsis, Info, Loader2, Search, X } from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useWidgetSize } from '@/components/dashboard/widget-size';
import { fitsSize, splitActions, splitRowActions } from '@/lib/widgets/runtime/size';
import { nextSortDir, sortRows, type SortState } from '@/lib/widgets/runtime/sort';
import { bulkCandidates, bulkNames, rowKey, rowLabel, selectAll, selectedRows, toggleSelected, type BulkCandidate } from '@/lib/widgets/runtime/bulk';
import { ConfirmActionDialog } from '@/components/widgets/shared/ConfirmActionDialog';
import { LayoutGrid, List, Package, Plus, RefreshCw, Settings, SquareTerminal } from 'lucide-react';
import { useWidgetData } from '@/hooks/useWidgetData';
import { useAuth } from '@/hooks/useAuth';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import { readJson } from '@/lib/api/readJson';
import { WidgetLoading } from '@/components/widgets/WidgetLoading';
import { WidgetError } from '@/components/widgets/WidgetError';
import { useWidgetFrame } from '@/components/dashboard/widget-context';
import { evalCond, fillTemplate, getPath, type ViewSpec } from '@/lib/widgets/runtime/spec';
import type { Block } from '@/lib/widgets/runtime/spec-v2';
import type { MenuEntry, ScreenSpec } from '@/lib/widgets/runtime/spec-screens';
import type { ViewContext } from '@/lib/widgets/runtime/layout';
import { MetricsChartWidget } from '@/components/widgets/metrics-chart/MetricsChartWidget';
import { Bar, DOT, Fields, formatValue, ICONS, IconBtn, type Row } from './parts';
import { LayoutBlocks, type LayoutUi } from './LayoutView';
import { WidgetFillContext } from './fill';
import { TrendProvider } from './trends';
import { inputClass, toolbarButtonClass } from './styles';
import { ScreenDialog } from './ScreenDialog';
import { RowSheet } from './RowSheet';
import { useActionRunner, type PublicAction } from './useActionRunner';

/** What the browser gets from /api/widget-runtime/:type (no commands, no scripts). */
export interface PublicSpec {
  version: number;
  view: ViewSpec & { blocks?: Block[] };
  data: { source: string };
  actions: PublicAction[];
  screens?: Record<string, ScreenSpec>;
  menu?: MenuEntry[];
}

/** Fetches the public spec of a widget type (shared by the widget and the full-page screens). */
export function usePublicSpec(widgetType: string) {
  const [spec, setSpec] = useState<PublicSpec | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await fetchWithAuth(`/api/widget-runtime/${encodeURIComponent(widgetType)}`);
        const json = await readJson<{ data?: { spec: PublicSpec }; error?: { message?: string } }>(res);
        if (!live) return;
        if (!res.ok || !json.data) { setError(json.error?.message || 'This widget has no definition'); return; }
        setSpec(json.data.spec);
      } catch (err) {
        if (live) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => { live = false; };
  }, [widgetType]);
  return { spec, error };
}

const MENU_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  plus: Plus, settings: Settings, 'layout-grid': LayoutGrid, list: List, package: Package, download: ICONS.download, terminal: SquareTerminal, 'refresh-cw': RefreshCw, info: Info,
};

/** The header checkbox of a bulk-selectable table: checked when every visible row is selected, mixed when only some are. */
function SelectAllCheckbox({ checked, indeterminate, onChange, label }: {
  checked: boolean; indeterminate: boolean; onChange: (on: boolean) => void; label: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = indeterminate; }, [indeterminate]);
  return <input ref={ref} type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} aria-label={label} className="size-3.5 accent-primary" />;
}

export interface V1Props {
  view: ViewSpec;
  data: unknown;
  widgetId: string;
  serverId: string;
  actions: Map<string, PublicAction>;
  allowed: (a: PublicAction) => boolean;
  busy: string | null;
  start: (a: PublicAction, row: Row | null) => void;
  /** Run an action on a row without asking first (a bulk run sends one request per row through the same path). */
  run?: (a: PublicAction, row: Row) => Promise<{ jobId?: string }>;
  /** Wait for a background job a bulk run started, so the next row does not race it. */
  waitForJob?: (jobId: string) => Promise<void>;
  /** Reload after a bulk run. */
  refresh?: () => void;
  /** Show a message in the widget's or page's notice area (the result of a bulk run). */
  notify?: (message: string) => void;
  /** A full-page table offers bulk selection; a widget on a dashboard does not. */
  page?: boolean;
  /** Open the screen named by `view.open` in a side sheet, with the clicked row as its context. */
  openRow?: (screenId: string, row: Row) => void;
}

/** A version 1 view (list, table, fields, text, chart) over some data, with its filter, toggles, summary and row actions. */
export function V1View({ view, data, widgetId, serverId, actions, allowed, busy, start, run, waitForJob, refresh, notify, page, openRow }: V1Props) {
  const [query, setQuery] = useState('');
  const [toggles, setToggles] = useState<Record<string, boolean>>(() => Object.fromEntries((view.toggles ?? []).map(t => [t.key, t.default])));
  const defaultSort = useMemo<SortState | null>(() => {
    const d = view.defaultSort;
    if (!d) return null;
    const column = (view.columns ?? []).find(c => c.title === d.column && c.sort);
    return column ? { field: column.sort!, dir: d.dir } : null;
  }, [view.defaultSort, view.columns]);
  const [sort, setSort] = useState<SortState | null>(defaultSort);

  const rows: Row[] = useMemo(() => {
    if (view.type === 'text' || view.type === 'fields' || view.type === 'chart' || view.type === 'layout') return [];
    const list = Array.isArray(data) ? (data as Row[]) : data && typeof data === 'object' ? [data as Row] : [];
    const q = query.trim().toLowerCase();
    const filtered = list.filter(r => {
      for (const t of view.toggles ?? []) if (!toggles[t.key] && evalCond(t.hideWhen, r)) return false;
      if (q && view.filter) return view.filter.fields.some(f => String(getPath(r, f) ?? '').toLowerCase().includes(q));
      return true;
    });
    return sort ? sortRows(filtered, sort.field, sort.dir) : filtered;
  }, [data, view, query, toggles, sort]);
  const { size } = useWidgetSize();
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [bulkConfirm, setBulkConfirm] = useState<BulkCandidate<PublicAction> | null>(null);
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number; failed: number } | null>(null);

  if (view.type === 'chart') return <MetricsChartWidget widgetId={widgetId} serverId={serverId} defaultMetrics={view.chart?.metrics} />;
  if (data === null || data === undefined) return <div className="p-2 text-sm text-muted-foreground">Waiting for the first data from this host…</div>;
  const all: Row[] = Array.isArray(data) ? (data as Row[]) : [];

  // Bulk selection is for page-size tables: a dashboard widget keeps its compact row actions.
  const bulkEnabled = page === true && view.type === 'table' && (view.bulk?.length ?? 0) > 0 && !!run;
  const picked = selectedRows(rows, selected);
  const candidates = bulkEnabled ? bulkCandidates(view, rows, selected, actions, allowed) : [];
  const allSelected = rows.length > 0 && rows.every(row => selected.has(rowKey(row)));
  const someSelected = !allSelected && rows.some(row => selected.has(rowKey(row)));

  const openBulk = (candidate: BulkCandidate<PublicAction>) => {
    setBulkProgress(null);
    setBulkConfirm(candidate);
  };

  /** One request per row, sequentially, through the same `run` path a single row action uses. */
  const runBulk = async () => {
    if (!bulkConfirm || !run) return;
    const { action, rows: targets, skipped } = bulkConfirm;
    let succeeded = 0;
    let failed = 0;
    setBulkProgress({ done: 0, total: targets.length, failed: 0 });
    for (let i = 0; i < targets.length; i++) {
      try {
        const { jobId } = await run(action, targets[i]);
        // A job action answers before its work is done; finish it before the next row, or the two jobs collide.
        if (jobId && waitForJob) await waitForJob(jobId);
        succeeded++;
      } catch {
        failed++;
      }
      setBulkProgress({ done: i + 1, total: targets.length, failed });
    }
    setSelected(new Set());
    refresh?.();
    notify?.(`${action.label}: ${succeeded} done${failed ? `, ${failed} failed` : ''}${skipped ? `, ${skipped} skipped` : ''}`);
  };

  // The row's actions that apply: as many as the widget has room for are buttons, the rest sit in a "more" menu.
  // A page-size table shows at most two icons and keeps the rest (destructive ones last) in that menu.
  const rowButtons = (row: Row, ids: string[], mode: 'widget' | 'table' | 'all' = 'widget') => {
    const list = ids.map(id => actions.get(id)).filter((a): a is PublicAction => !!a)
      .filter(a => allowed(a) && (!a.when || evalCond(a.when, row)));
    const rowName = view.type === 'list' && view.row ? fillTemplate(view.row.title, row) : '';
    const { shown, more } = mode === 'table'
      ? splitRowActions(list, 2, a => !!a.confirm?.destructive)
      : mode === 'all' ? { shown: list, more: [] as PublicAction[] }
      : splitActions(list, size, view.row?.inline);
    const iconOf = (a: PublicAction) => (a.icon && ICONS[a.icon]) || Info;
    return (
      <>
        {shown.map(a => {
          const Icon = iconOf(a);
          return <IconBtn key={a.id} label={rowName ? `${a.label} ${rowName}` : a.label} onClick={() => start(a, row)} disabled={busy !== null}><Icon /></IconBtn>;
        })}
        {more.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconBtn label={rowName ? `More actions for ${rowName}` : 'More actions'} disabled={busy !== null}><Ellipsis /></IconBtn>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              {more.map(a => {
                const Icon = iconOf(a);
                return <DropdownMenuItem key={a.id} variant={a.confirm?.destructive ? 'destructive' : 'default'} onSelect={() => start(a, row)}><Icon />{a.label}</DropdownMenuItem>;
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </>
    );
  };
  // A row opens the view's `open` screen (in a side sheet) when the spec says so; otherwise it is not clickable.
  const clickable = !!view.open && !!openRow;
  const openRowFor = (row: Row) => { if (view.open && openRow) openRow(view.open, row); };
  const rowProps = (row: Row) => clickable ? {
    tabIndex: 0,
    onClick: () => openRowFor(row),
    onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); openRowFor(row); } },
  } : {};
  const columns = (view.columns ?? []).filter(c => fitsSize(c, size));
  const showSubtitle = !view.row?.subtitleHideBelow || fitsSize({ hideBelow: view.row.subtitleHideBelow }, size);
  const summary = (view.summary ?? []).filter(s => fitsSize(s, size));
  const showFilter = !!view.filter && fitsSize(view.filter, size);
  const toggleList = (view.toggles ?? []).filter(t => fitsSize(t, size));

  const content = () => {
    if (view.type === 'fields') {
      const obj = (Array.isArray(data) ? (data[0] ?? null) : data) as Row | null;
      if (!obj || typeof obj !== 'object') return <div className="py-4 text-center text-xs text-muted-foreground">{view.empty || 'Nothing to show'}</div>;
      return <div className="min-h-0 flex-1 overflow-auto"><Fields fields={view.fields ?? []} data={obj} /></div>;
    }
    if (view.type === 'text') {
      const root = (data && typeof data === 'object' ? data : { text: String(data) }) as Row;
      return <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">{fillTemplate(view.text ?? '', root)}</pre>;
    }
    if (rows.length === 0) return <div className="py-4 text-center text-xs text-muted-foreground">{view.empty || 'Nothing to show'}</div>;
    if (view.type === 'list' && view.row) {
      const r = view.row;
      return (
        <ul className="min-h-0 flex-1 divide-y divide-border overflow-auto">
          {rows.map((row, i) => (
            <li key={i} {...rowProps(row)} className={`flex items-center gap-2 py-1.5 ${clickable ? 'cursor-pointer hover:bg-muted' : ''}`}>
              {r.dot && <span className={`size-2 shrink-0 rounded-full ${DOT[r.dot.colors[String(getPath(row, r.dot.field) ?? '')]] || 'bg-muted-foreground'}`} aria-hidden />}
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="truncate font-medium">{fillTemplate(r.title, row)}</span>
                  {r.badge && fillTemplate(r.badge, row) && <span className="hidden truncate rounded bg-muted px-1 text-[10px] text-muted-foreground sm:inline">{fillTemplate(r.badge, row)}</span>}
                </div>
                {r.subtitle && showSubtitle && <div className="truncate text-xs text-muted-foreground" title={fillTemplate(r.subtitle, row)}>{fillTemplate(r.subtitle, row)}</div>}
                {r.fields && <div className="mt-1"><Fields fields={r.fields} data={row} /></div>}
              </div>
              <div className="flex shrink-0 items-center gap-0.5" onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
                {busy !== null && <Loader2 className="size-4 animate-spin text-muted-foreground motion-reduce:animate-none" aria-label="Working" />}
                {rowButtons(row, r.actions)}
              </div>
            </li>
          ))}
        </ul>
      );
    }
    const cols = columns;
    return (
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 bg-card text-muted-foreground">
            <tr>
              {bulkEnabled && (
                <th className="w-0 px-2 py-1">
                  <SelectAllCheckbox checked={allSelected} indeterminate={someSelected} onChange={on => setSelected(s => selectAll(s, rows, on))} label="Select all rows" />
                </th>
              )}
              {cols.map(c => (
                <th key={c.title} className="px-2 py-1 font-medium"
                  aria-sort={c.sort ? (sort?.field === c.sort ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none') : undefined}>
                  {c.sort ? (
                    <button type="button" className="inline-flex items-center gap-1 hover:text-foreground"
                      onClick={() => {
                        const field = c.sort!;
                        setSort(s => ({ field, dir: s && s.field === field ? nextSortDir(s.dir) : 'asc' }));
                      }}>
                      {c.title}
                      {sort?.field === c.sort && (sort.dir === 'asc' ? <ChevronUp className="size-3" aria-hidden /> : <ChevronDown className="size-3" aria-hidden />)}
                    </button>
                  ) : c.title}
                </th>
              ))}
              {(view.rowActions?.length ?? 0) > 0 && <th className="w-0" />}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((row, i) => (
              <tr key={i} {...rowProps(row)} className={clickable ? 'cursor-pointer hover:bg-muted' : undefined}>
                {bulkEnabled && (
                  <td className="px-2 py-1" onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
                    <input type="checkbox" checked={selected.has(rowKey(row))} onChange={e => setSelected(s => toggleSelected(s, rowKey(row), e.target.checked))}
                      aria-label={`Select ${rowLabel(view, row) || 'row'}`} className="size-3.5 accent-primary" />
                  </td>
                )}
                {cols.map(c => {
                  const text = formatValue(fillTemplate(c.value, row), c.format);
                  const bar = c.format === 'bar' ? Number(fillTemplate(c.value, row)) : NaN;
                  return <td key={c.title} className="px-2 py-1">{c.format === 'badge' ? <span className="rounded bg-muted px-1">{text}</span> : Number.isFinite(bar) ? <div className="min-w-[4rem]"><div className="text-right">{text}</div><Bar value={bar} /></div> : text}</td>;
                })}
                {(view.rowActions?.length ?? 0) > 0 && <td className="px-2 py-1 text-right" onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}><div className="flex justify-end gap-0.5">{rowButtons(row, view.rowActions ?? [], size === 'lg' ? 'table' : 'all')}</div></td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {(summary.length || showFilter || toggleList.length) ? (
        <div className="flex flex-wrap items-center gap-2">
          {summary.map(s => (
            <span key={s.label} className="text-xs text-muted-foreground">
              <span className="font-semibold text-foreground">{s.where ? all.filter(r => evalCond(s.where!, r)).length : all.length}</span> {s.label}
            </span>
          ))}
          {showFilter && view.filter && (
            <div className="relative ml-auto min-w-0 flex-1 basis-32 sm:max-w-[220px]">
              <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <input value={query} onChange={e => setQuery(e.target.value)} placeholder={view.filter.placeholder || 'Filter'} aria-label="Filter"
                className={`${inputClass} pl-7`} />
            </div>
          )}
          {toggleList.map(t => (
            <label key={t.key} className="flex items-center gap-1 text-xs text-muted-foreground">
              <input type="checkbox" checked={!!toggles[t.key]} onChange={e => setToggles(s => ({ ...s, [t.key]: e.target.checked }))} /> {t.label}
            </label>
          ))}
        </div>
      ) : null}
      {bulkEnabled && picked.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted px-2 py-1 text-xs">
          <span className="font-medium">{picked.length} selected</span>
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            {candidates.map(candidate => (
              <button key={candidate.action.id} type="button" className={toolbarButtonClass('small', candidate.action.confirm?.destructive ? 'destructive' : 'outline')}
                onClick={() => openBulk(candidate)}>
                {candidate.action.label}
              </button>
            ))}
          </div>
        </div>
      )}
      {content()}
      {bulkConfirm && (
        <ConfirmActionDialog
          open
          onOpenChange={open => { if (!open) { setBulkConfirm(null); setBulkProgress(null); } }}
          title={`${bulkConfirm.action.label} ${bulkConfirm.rows.length} ${bulkConfirm.rows.length === 1 ? 'row' : 'rows'}?`}
          confirmLabel={bulkConfirm.action.label}
          destructive={!!bulkConfirm.action.confirm?.destructive}
          description={(() => {
            const names = bulkNames(view, bulkConfirm.rows);
            return (
              <div className="space-y-2">
                {names.names.length > 0 && <ul className="max-h-40 list-disc overflow-auto pl-4">{names.names.map((name, i) => <li key={i}>{name || '—'}</li>)}</ul>}
                {names.more > 0 && <p>and {names.more} more</p>}
                {bulkConfirm.skipped > 0 && <p>{bulkConfirm.skipped} selected {bulkConfirm.skipped === 1 ? 'row does' : 'rows do'} not apply and will be skipped.</p>}
                {bulkProgress && <p role="status">{bulkProgress.done} of {bulkProgress.total}{bulkProgress.failed ? `, ${bulkProgress.failed} failed` : ''}</p>}
              </div>
            );
          })()}
          onConfirm={runBulk}
        />
      )}
    </div>
  );
}

interface Props {
  widgetId: string;
  widgetType: string;
  serverId: string;
}

/**
 * Renders a package widget from its declarative spec: a list, table or text view over the widget's data (version 1), or a
 * layout of sections, forms, buttons and job progress (version 2). Actions call the same endpoint API keys use
 * (/api/servers/:id/widget-actions/...), so they are subject to the same permission, confirmation and validation rules.
 * Version 2 widgets can also declare screens: pop-ups opened by a row action or a menu entry of the widget, and full pages.
 */
export function DeclarativeWidget({ widgetId, widgetType, serverId }: Props) {
  const { data, isLoading, error, refresh, unavailable, extra } = useWidgetData(widgetId, 15);
  const { can } = useAuth();
  const router = useRouter();
  const frame = useWidgetFrame();
  const { spec, error: specError } = usePublicSpec(widgetType);
  const [screen, setScreen] = useState<{ id: string; row: Row | null } | null>(null);
  // A row's details, opened by clicking a table/list row whose view names a screen with `open` (shown in a side sheet).
  const [detail, setDetail] = useState<{ id: string; row: Row } | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const view = spec?.view;
  const isLayout = view?.type === 'layout';
  const rowTitle = useMemo(() => (view?.type === 'list' && view.row ? (r: Row) => fillTemplate(view.row!.title, r) : undefined), [view]);
  const ctx: ViewContext = { data, collectedAt: extra.collectedAt, state: extra.state, config: extra.config, lookups: extra.lookups, server: extra.server };

  const runner = useActionRunner({
    actions: spec?.actions ?? [], version: spec?.version ?? 1, serverId, widgetType, widgetId, templateContext: ctx, rowTitle,
    changed: () => { refresh(); setReloadToken(n => n + 1); },
    openScreen: (id, row) => {
      const s = spec?.screens?.[id];
      if (!s) return;
      if (s.kind === 'page') router.push(`/widgets/${encodeURIComponent(widgetId)}/${encodeURIComponent(id)}`);
      else setScreen({ id, row });
    },
  });
  const { busy, notice, setNotice, job, allowed, start } = runner;

  // The package's own entries of the widget's ⋮ menu (New container, Manage, ...), for those who may use what they open.
  const menuKey = JSON.stringify((spec?.menu ?? []).map(m => [m.id, m.label, m.screen, m.permission]));
  useEffect(() => {
    if (!frame || !spec?.menu?.length) return;
    const items = spec.menu.filter(m => !m.permission || can(m.permission, serverId)).map(m => ({
      id: m.id, label: m.label, icon: m.icon ? MENU_ICONS[m.icon] : undefined,
      onSelect: () => {
        const s = spec.screens?.[m.screen];
        if (!s) return;
        if (s.kind === 'page') router.push(`/widgets/${encodeURIComponent(widgetId)}/${encodeURIComponent(m.screen)}`);
        else setScreen({ id: m.screen, row: null });
      },
    }));
    return frame.registerMenu(items);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frame, menuKey, can, serverId, widgetId]);

  if (specError) return <div className="p-2 text-sm text-muted-foreground">{specError}</div>;
  if (!spec || !view) return <WidgetLoading />;
  if (isLoading && data === null) return <WidgetLoading />;
  if (error) return <WidgetError error={error} onRetry={refresh} serverId={serverId} />;
  if (unavailable) return <div className="p-2 text-sm text-muted-foreground">{unavailable}</div>;

  const actionsById = new Map(spec.actions.map(a => [a.id, a]));
  const fullCtx: ViewContext = { ...ctx, job };

  const v1 = (v: ViewSpec, d: unknown) => (
    <V1View view={v} data={d} widgetId={widgetId} serverId={serverId} actions={actionsById} allowed={allowed} busy={busy} start={start}
      run={runner.run} waitForJob={runner.waitForJob} refresh={refresh} notify={setNotice} page={false}
      openRow={(id, row) => { if (spec.screens?.[id]) setDetail({ id, row }); }} />
  );

  const ui: LayoutUi = {
    actions: actionsById,
    allowed,
    busy,
    onAction: (a, params) => start(a, null, params),
    renderView: v1,
    onCancelJob: () => { runner.cancelJob().catch(err => setNotice(`Cancel failed: ${err instanceof Error ? err.message : String(err)}`)); },
    submit: runner.submit,
  };

  const body = isLayout
    ? (
      <div className="min-h-0 flex-1 overflow-auto">
        {extra.stateError && <div role="alert" className="mb-2 rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">Checking this host failed: {extra.stateError}</div>}
        {/* A widget fills its body; its dialogs and pages do not. */}
        <WidgetFillContext.Provider value>
          <TrendProvider serverId={serverId} source={view} refreshKey={data}>
            <LayoutBlocks blocks={view.blocks ?? []} ctx={fullCtx} ui={ui} />
          </TrendProvider>
        </WidgetFillContext.Provider>
      </div>
    )
    : <TrendProvider serverId={serverId} source={view} refreshKey={data}>{v1(view, data)}</TrendProvider>;

  const open = screen ? spec.screens?.[screen.id] : undefined;
  const detailScreen = detail ? spec.screens?.[detail.id] : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 text-sm">
      {notice && (
        <div className="flex items-center justify-between rounded border border-primary/30 bg-primary/10 px-2 py-1 text-xs text-primary">
          <span className="truncate">{notice}</span>
          <button onClick={() => setNotice(null)} aria-label="Dismiss"><X className="size-3" /></button>
        </div>
      )}
      {body}
      {runner.dialogs}

      <ScreenDialog id={screen?.id ?? null} row={screen?.row ?? null} screen={open} ctx={fullCtx} serverId={serverId} widgetType={widgetType} ui={ui}
        reloadToken={reloadToken} onClose={() => setScreen(null)} onDone={refresh} />
      <RowSheet id={detail?.id ?? null} row={detail?.row ?? null} screen={detailScreen} ctx={fullCtx} serverId={serverId} widgetType={widgetType} ui={ui}
        reloadToken={reloadToken} onClose={() => setDetail(null)} onDone={refresh} />
    </div>
  );
}
