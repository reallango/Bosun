'use client';

import { useEffect, useMemo, useState } from 'react';
import { Dialog } from 'radix-ui';
import { useRouter } from 'next/navigation';
import { Info, Loader2, Search, X } from 'lucide-react';
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
import { ScreenView } from './ScreenView';
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

const DIALOG_WIDTH: Record<string, string> = { md: 'sm:max-w-lg', lg: 'sm:max-w-3xl', xl: 'sm:max-w-5xl' };

export interface V1Props {
  view: ViewSpec;
  data: unknown;
  widgetId: string;
  serverId: string;
  actions: Map<string, PublicAction>;
  allowed: (a: PublicAction) => boolean;
  busy: string | null;
  start: (a: PublicAction, row: Row | null) => void;
}

/** A version 1 view (list, table, fields, text, chart) over some data, with its filter, toggles, summary and row actions. */
export function V1View({ view, data, widgetId, serverId, actions, allowed, busy, start }: V1Props) {
  const [query, setQuery] = useState('');
  const [toggles, setToggles] = useState<Record<string, boolean>>(() => Object.fromEntries((view.toggles ?? []).map(t => [t.key, t.default])));

  const rows: Row[] = useMemo(() => {
    if (view.type === 'text' || view.type === 'fields' || view.type === 'chart' || view.type === 'layout') return [];
    const list = Array.isArray(data) ? (data as Row[]) : data && typeof data === 'object' ? [data as Row] : [];
    const q = query.trim().toLowerCase();
    return list.filter(r => {
      for (const t of view.toggles ?? []) if (!toggles[t.key] && evalCond(t.hideWhen, r)) return false;
      if (q && view.filter) return view.filter.fields.some(f => String(getPath(r, f) ?? '').toLowerCase().includes(q));
      return true;
    });
  }, [data, view, query, toggles]);

  if (view.type === 'chart') return <MetricsChartWidget widgetId={widgetId} serverId={serverId} defaultMetrics={view.chart?.metrics} />;
  if (data === null || data === undefined) return <div className="p-2 text-sm text-gray-500">Waiting for the first data from this host…</div>;
  const all: Row[] = Array.isArray(data) ? (data as Row[]) : [];

  const rowButtons = (row: Row, ids: string[]) => ids.map(id => actions.get(id)).filter((a): a is PublicAction => !!a)
    .filter(a => allowed(a) && (!a.when || evalCond(a.when, row)))
    .map(a => {
      const Icon = (a.icon && ICONS[a.icon]) || Info;
      const label = `${a.label}${view.type === 'list' && view.row ? ` ${fillTemplate(view.row.title, row)}` : ''}`;
      return <IconBtn key={a.id} label={label} onClick={() => start(a, row)} disabled={busy !== null}><Icon /></IconBtn>;
    });

  const content = () => {
    if (view.type === 'fields') {
      const obj = (Array.isArray(data) ? (data[0] ?? null) : data) as Row | null;
      if (!obj || typeof obj !== 'object') return <div className="py-4 text-center text-xs text-gray-500">{view.empty || 'Nothing to show'}</div>;
      return <div className="min-h-0 flex-1 overflow-auto"><Fields fields={view.fields ?? []} data={obj} /></div>;
    }
    if (view.type === 'text') {
      const root = (data && typeof data === 'object' ? data : { text: String(data) }) as Row;
      return <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">{fillTemplate(view.text ?? '', root)}</pre>;
    }
    if (rows.length === 0) return <div className="py-4 text-center text-xs text-gray-500">{view.empty || 'Nothing to show'}</div>;
    if (view.type === 'list' && view.row) {
      const r = view.row;
      return (
        <ul className="min-h-0 flex-1 divide-y divide-gray-100 overflow-auto dark:divide-gray-800">
          {rows.map((row, i) => (
            <li key={i} className="flex items-center gap-2 py-1.5">
              {r.dot && <span className={`size-2 shrink-0 rounded-full ${DOT[r.dot.colors[String(getPath(row, r.dot.field) ?? '')]] || 'bg-gray-400'}`} aria-hidden />}
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="truncate font-medium">{fillTemplate(r.title, row)}</span>
                  {r.badge && fillTemplate(r.badge, row) && <span className="hidden truncate rounded bg-gray-100 px-1 text-[10px] text-gray-500 dark:bg-gray-800 sm:inline">{fillTemplate(r.badge, row)}</span>}
                </div>
                {r.subtitle && <div className="truncate text-xs text-gray-500" title={fillTemplate(r.subtitle, row)}>{fillTemplate(r.subtitle, row)}</div>}
                {r.fields && <div className="mt-1"><Fields fields={r.fields} data={row} /></div>}
              </div>
              <div className="flex shrink-0 items-center gap-0.5">
                {busy !== null && <Loader2 className="size-4 animate-spin text-gray-400 motion-reduce:animate-none" aria-label="Working" />}
                {rowButtons(row, r.actions)}
              </div>
            </li>
          ))}
        </ul>
      );
    }
    const cols = view.columns ?? [];
    return (
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 bg-white text-gray-500 dark:bg-gray-900">
            <tr>{cols.map(c => <th key={c.title} className="px-2 py-1 font-medium">{c.title}</th>)}{(view.rowActions?.length ?? 0) > 0 && <th className="w-0" />}</tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
            {rows.map((row, i) => (
              <tr key={i}>
                {cols.map(c => {
                  const text = formatValue(fillTemplate(c.value, row), c.format);
                  const bar = c.format === 'bar' ? Number(fillTemplate(c.value, row)) : NaN;
                  return <td key={c.title} className="px-2 py-1">{c.format === 'badge' ? <span className="rounded bg-gray-100 px-1 dark:bg-gray-800">{text}</span> : Number.isFinite(bar) ? <div className="min-w-[4rem]"><div className="text-right">{text}</div><Bar value={bar} /></div> : text}</td>;
                })}
                {(view.rowActions?.length ?? 0) > 0 && <td className="px-2 py-1 text-right"><div className="flex justify-end gap-0.5">{rowButtons(row, view.rowActions ?? [])}</div></td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {(view.summary?.length || view.filter || view.toggles?.length) ? (
        <div className="flex flex-wrap items-center gap-2">
          {view.summary?.map(s => (
            <span key={s.label} className="text-xs text-gray-500">
              <span className="font-semibold text-gray-900 dark:text-gray-100">{s.where ? all.filter(r => evalCond(s.where!, r)).length : all.length}</span> {s.label}
            </span>
          ))}
          {view.filter && (
            <div className="relative ml-auto min-w-0 flex-1 basis-32 sm:max-w-[220px]">
              <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-gray-400" aria-hidden />
              <input value={query} onChange={e => setQuery(e.target.value)} placeholder={view.filter.placeholder || 'Filter'} aria-label="Filter"
                className="w-full rounded-md border border-gray-200 bg-transparent py-1 pl-7 pr-2 text-xs outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-700" />
            </div>
          )}
          {view.toggles?.map(t => (
            <label key={t.key} className="flex items-center gap-1 text-xs text-gray-500">
              <input type="checkbox" checked={!!toggles[t.key]} onChange={e => setToggles(s => ({ ...s, [t.key]: e.target.checked }))} /> {t.label}
            </label>
          ))}
        </div>
      ) : null}
      {content()}
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

  if (specError) return <div className="p-2 text-sm text-gray-500">{specError}</div>;
  if (!spec || !view) return <WidgetLoading />;
  if (isLoading && data === null) return <WidgetLoading />;
  if (error) return <WidgetError error={error} onRetry={refresh} serverId={serverId} />;
  if (unavailable) return <div className="p-2 text-sm text-gray-500">{unavailable}</div>;

  const actionsById = new Map(spec.actions.map(a => [a.id, a]));
  const fullCtx: ViewContext = { ...ctx, job };

  const v1 = (v: ViewSpec, d: unknown) => (
    <V1View view={v} data={d} widgetId={widgetId} serverId={serverId} actions={actionsById} allowed={allowed} busy={busy} start={start} />
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
        <LayoutBlocks blocks={view.blocks ?? []} ctx={fullCtx} ui={ui} />
      </div>
    )
    : v1(view, data);

  const open = screen ? spec.screens?.[screen.id] : undefined;
  const screenCtx: ViewContext = { ...fullCtx, context: screen?.row ?? undefined };

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 text-sm">
      {notice && (
        <div className="flex items-center justify-between rounded bg-blue-50 px-2 py-1 text-xs text-blue-800 dark:bg-blue-950/50 dark:text-blue-200">
          <span className="truncate">{notice}</span>
          <button onClick={() => setNotice(null)} aria-label="Dismiss"><X className="size-3" /></button>
        </div>
      )}
      {body}
      {runner.dialogs}

      <Dialog.Root open={!!open} onOpenChange={o => { if (!o) setScreen(null); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
          <Dialog.Content
            className={`fixed inset-x-2 top-4 z-50 mx-auto flex max-h-[92vh] flex-col rounded-xl border border-gray-200 bg-white p-4 shadow-xl dark:border-gray-700 dark:bg-gray-900 ${DIALOG_WIDTH[open?.size ?? 'lg']}`}
            aria-describedby={undefined}
          >
            <div className="mb-3 flex items-start justify-between gap-2">
              <Dialog.Title className="min-w-0 truncate text-base font-semibold">{open ? fillTemplate(open.title, screenCtx) : ''}</Dialog.Title>
              <Dialog.Close asChild><IconBtn label="Close"><X /></IconBtn></Dialog.Close>
            </div>
            <div className="min-h-0 flex-1 overflow-auto pr-1">
              {open && screen && (
                <ScreenView key={screen.id + JSON.stringify(screen.row ?? {})} screen={open} context={screenCtx} serverId={serverId} widgetType={widgetType}
                  ui={ui} reloadToken={reloadToken} onDone={() => { if (!open.keepOpenAfterSubmit) setScreen(null); refresh(); }} />
              )}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
