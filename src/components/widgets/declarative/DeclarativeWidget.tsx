'use client';

import { useEffect, useMemo, useState } from 'react';
import { Dialog } from 'radix-ui';
import dynamic from 'next/dynamic';
import { Info, Loader2, Search, X } from 'lucide-react';
import { useWidgetData } from '@/hooks/useWidgetData';
import { useWidgetJob } from '@/hooks/useWidgetJob';
import { useAuth } from '@/hooks/useAuth';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import { readJson } from '@/lib/api/readJson';
import { WidgetLoading } from '@/components/widgets/WidgetLoading';
import { WidgetError } from '@/components/widgets/WidgetError';
import { ConfirmActionDialog, apiAction } from '@/components/widgets/shared/ConfirmActionDialog';
import { evalCond, fillTemplate, getPath, type ViewSpec, type ParamSpec } from '@/lib/widgets/runtime/spec';
import type { Block } from '@/lib/widgets/runtime/spec-v2';
import type { PublicActionLike, ViewContext } from '@/lib/widgets/runtime/layout';
import { hasRole } from '@/lib/auth/levels';
import { MetricsChartWidget } from '@/components/widgets/metrics-chart/MetricsChartWidget';
import { Bar, DOT, Fields, formatValue, ICONS, IconBtn, type Row } from './parts';
import { LayoutBlocks, type LayoutUi } from './LayoutView';

// The terminal (xterm) loads only when a container shell is opened.
const SSHTerminalWidget = dynamic(
  () => import('@/components/widgets/ssh-terminal').then(m => m.SSHTerminalWidget),
  { ssr: false, loading: () => <WidgetLoading /> },
);

/** What the browser gets from /api/widget-runtime/:type (no commands, no scripts). */
type PublicAction = PublicActionLike;
interface PublicSpec { version: number; view: ViewSpec & { blocks?: Block[] }; data: { source: string }; actions: PublicAction[] }

/** The values an action is called with: a parameter's `from` field of the row, else its default. */
function paramsFor(action: PublicAction, row: Row | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, p] of Object.entries(action.params) as [string, ParamSpec][]) {
    const fromRow = p.from && row ? getPath(row, p.from) : undefined;
    out[name] = fromRow !== undefined && fromRow !== null ? (p.type === 'number' ? Number(fromRow) : p.type === 'boolean' ? Boolean(fromRow) : String(fromRow)) : p.default;
  }
  return out;
}

interface V1Props {
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
function V1View({ view, data, widgetId, serverId, actions, allowed, busy, start }: V1Props) {
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

interface Pending { action: PublicAction; row: Row | null; params?: Record<string, unknown> }

/**
 * Renders a package widget from its declarative spec: a list, table or text view over the widget's data (version 1), or a
 * layout of sections, forms, buttons and job progress (version 2). Actions call the same endpoint API keys use
 * (/api/servers/:id/widget-actions/...), so they are subject to the same permission, confirmation and validation rules.
 */
export function DeclarativeWidget({ widgetId, widgetType, serverId }: Props) {
  const { data, isLoading, error, refresh, unavailable, extra } = useWidgetData(widgetId, 15);
  const { user, can } = useAuth();
  const [shellFor, setShellFor] = useState<{ token: string; label: string } | null>(null);
  const [spec, setSpec] = useState<PublicSpec | null>(null);
  const [specError, setSpecError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [output, setOutput] = useState<{ title: string; text: string } | null>(null);
  const { job, refresh: refreshJob, cancel } = useWidgetJob(serverId, widgetType, !!spec?.actions.some(a => a.job));

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await fetchWithAuth(`/api/widget-runtime/${encodeURIComponent(widgetType)}`);
        const json = await readJson<{ data?: { spec: PublicSpec }; error?: { message?: string } }>(res);
        if (!live) return;
        if (!res.ok || !json.data) { setSpecError(json.error?.message || 'This widget has no definition'); return; }
        setSpec(json.data.spec);
      } catch (err) {
        if (live) setSpecError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => { live = false; };
  }, [widgetType]);

  const view = spec?.view;
  const isLayout = view?.type === 'layout';

  if (specError) return <div className="p-2 text-sm text-gray-500">{specError}</div>;
  if (!spec || !view) return <WidgetLoading />;
  if (isLoading && data === null) return <WidgetLoading />;
  if (error) return <WidgetError error={error} onRetry={refresh} serverId={serverId} />;
  if (unavailable) return <div className="p-2 text-sm text-gray-500">{unavailable}</div>;

  const actionsById = new Map(spec.actions.map(a => [a.id, a]));
  // A web terminal asks for the person's own login and is only available to Full access; the action's permission still applies.
  const allowed = (a: PublicAction) => can(a.permission, serverId) && (a.kind !== 'terminal' || hasRole(user?.role, 'admin'));
  const ctx: ViewContext = { data, collectedAt: extra.collectedAt, state: extra.state, config: extra.config, lookups: extra.lookups, server: extra.server, job };

  const run = async (action: PublicAction, row: Row | null, override?: Record<string, unknown>) => {
    setBusy(action.id);
    try {
      const d = await apiAction(fetchWithAuth, `/api/servers/${serverId}/widget-actions/${encodeURIComponent(widgetType)}/${encodeURIComponent(action.id)}`, 'POST', {
        params: override ?? paramsFor(action, row), ...(action.confirm ? { confirm: true } : {}), ...(spec.version >= 2 ? { widgetId } : {}),
      }) as { success?: boolean; output?: string; error?: string; exitCode?: number; timedOut?: boolean; message?: string; jobId?: string };
      if (d.jobId) { await refreshJob(); return; }   // started in the background: the job block follows it
      const text = [d.output, d.error].filter(s => s && s.trim()).join('\n').trim();
      if (!d.success) throw new Error((d.message || text).slice(0, 300) || (d.timedOut ? 'The command timed out' : `The command failed (exit ${d.exitCode})`));
      if (action.result === 'text') setOutput({ title: `${action.label}${row && view.type === 'list' ? `: ${fillTemplate(view.row?.title ?? '', row)}` : ''}`, text: text || '(no output)' });
      else if (action.result === 'toast') setNotice(`${action.label}: ${d.message || (text ? text.split('\n')[0].slice(0, 120) : 'done')}`);
      if (action.after === 'refresh') setTimeout(refresh, 2500);
    } finally {
      setBusy(null);
    }
  };

  const start = (action: PublicAction, row: Row | null, params?: Record<string, unknown>) => {
    if (action.kind === 'terminal') {
      const ref = action.terminal ? String(getPath(row, action.terminal.ref) ?? '') : '';
      if (!ref) { setNotice(`${action.label}: this row has nothing to open it in`); return; }
      // The server checks the target and signs the command the package declared; the terminal then asks for the person's own login.
      apiAction(fetchWithAuth, `/api/servers/${serverId}/widget-actions/${encodeURIComponent(widgetType)}/${encodeURIComponent(action.id)}`, 'POST', { ref })
        .then(d => { const x = d as { token?: string; label?: string }; if (x.token) setShellFor({ token: x.token, label: x.label || ref }); else setNotice(`${action.label}: no terminal token was returned`); })
        .catch(err => setNotice(`${action.label}: ${err instanceof Error ? err.message : String(err)}`));
      return;
    }
    if (action.confirm) setPending({ action, row, params });
    else run(action, row, params).catch(err => setNotice(`${action.label} failed: ${err instanceof Error ? err.message : String(err)}`));
  };

  const v1 = (v: ViewSpec, d: unknown) => (
    <V1View view={v} data={d} widgetId={widgetId} serverId={serverId} actions={actionsById} allowed={allowed} busy={busy} start={start} />
  );

  const ui: LayoutUi = {
    actions: actionsById,
    allowed,
    busy,
    onAction: (a, params) => start(a, null, params),
    renderView: v1,
    onCancelJob: () => { cancel().catch(err => setNotice(`Cancel failed: ${err instanceof Error ? err.message : String(err)}`)); },
  };

  const body = isLayout
    ? (
      <div className="min-h-0 flex-1 overflow-auto">
        {extra.stateError && <div role="alert" className="mb-2 rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">Checking this host failed: {extra.stateError}</div>}
        <LayoutBlocks blocks={view.blocks ?? []} ctx={ctx} ui={ui} />
      </div>
    )
    : v1(view, data);

  const confirmCtx = (pending?.row ?? ctx) as unknown;

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 text-sm">
      {notice && (
        <div className="flex items-center justify-between rounded bg-blue-50 px-2 py-1 text-xs text-blue-800 dark:bg-blue-950/50 dark:text-blue-200">
          <span className="truncate">{notice}</span>
          <button onClick={() => setNotice(null)} aria-label="Dismiss"><X className="size-3" /></button>
        </div>
      )}
      {body}

      <ConfirmActionDialog
        open={!!pending}
        onOpenChange={o => { if (!o) setPending(null); }}
        title={pending?.action.confirm ? fillTemplate(pending.action.confirm.title, confirmCtx) : ''}
        description={pending?.action.confirm?.text ? fillTemplate(pending.action.confirm.text, confirmCtx) : (pending?.action.label ?? '')}
        confirmLabel={pending?.action.label ?? ''}
        destructive={!!pending?.action.confirm?.destructive}
        requireText={pending?.action.confirm?.requireText ? fillTemplate(pending.action.confirm.requireText, confirmCtx) : undefined}
        onConfirm={() => (pending ? run(pending.action, pending.row, pending.params) : undefined)}
      />

      <Dialog.Root open={!!shellFor} onOpenChange={o => { if (!o) setShellFor(null); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
          <Dialog.Content className="fixed inset-0 z-50 flex flex-col bg-white p-2 shadow-xl dark:bg-gray-900 sm:inset-6 sm:rounded-xl sm:border sm:border-gray-700 lg:inset-x-[8%]">
            <div className="mb-2 flex items-center justify-between gap-2 px-1">
              <Dialog.Title className="truncate font-semibold">{shellFor?.label}</Dialog.Title>
              <Dialog.Description className="sr-only">Interactive terminal session</Dialog.Description>
              <Dialog.Close asChild><IconBtn label="Close shell"><X /></IconBtn></Dialog.Close>
            </div>
            <div className="min-h-0 flex-1">
              {shellFor && <SSHTerminalWidget widgetId={`${widgetId}:exec:${shellFor.label}`} serverId={serverId} cmdToken={shellFor.token} cmdLabel={shellFor.label} />}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={!!output} onOpenChange={o => { if (!o) setOutput(null); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
          <Dialog.Content className="fixed inset-2 z-50 flex flex-col rounded-xl border border-gray-200 bg-white p-3 shadow-xl dark:border-gray-700 dark:bg-gray-900 sm:inset-8 lg:inset-x-[10%]">
            <div className="mb-2 flex items-center justify-between gap-2">
              <Dialog.Title className="truncate font-semibold">{output?.title}</Dialog.Title>
              <Dialog.Description className="sr-only">Output of the action</Dialog.Description>
              <Dialog.Close asChild><IconBtn label="Close"><X /></IconBtn></Dialog.Close>
            </div>
            <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded bg-gray-950 p-2 font-mono text-[11px] leading-snug text-gray-100">{output?.text}</pre>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
