'use client';

import { forwardRef, useEffect, useMemo, useState } from 'react';
import { Dialog } from 'radix-ui';
import dynamic from 'next/dynamic';
import {
  Download, Info, Loader2, Pause, Play, Power, RefreshCw, RotateCw, ScrollText, Search, Square, TerminalSquare, Trash2, Upload, X,
} from 'lucide-react';
import { useWidgetData } from '@/hooks/useWidgetData';
import { useAuth } from '@/hooks/useAuth';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import { readJson } from '@/lib/api/readJson';
import { WidgetLoading } from '@/components/widgets/WidgetLoading';
import { WidgetError } from '@/components/widgets/WidgetError';
import { ConfirmActionDialog, apiAction } from '@/components/widgets/shared/ConfirmActionDialog';
import { evalCond, fillTemplate, getPath, type ActionSpec, type FieldSpec, type ViewSpec, type ParamSpec } from '@/lib/widgets/runtime/spec';
import { hasRole } from '@/lib/auth/levels';

// The terminal (xterm) loads only when a container shell is opened.
const SSHTerminalWidget = dynamic(
  () => import('@/components/widgets/ssh-terminal').then(m => m.SSHTerminalWidget),
  { ssr: false, loading: () => <WidgetLoading /> },
);

/** Container names the terminal accepts (the same rule the server applies). */
const CONTAINER_REF_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

/** What the browser gets from /api/widget-runtime/:type (no commands). */
type PublicAction = Omit<ActionSpec, 'command' | 'windowsCommand' | 'as' | 'timeoutSec'>;
interface PublicSpec { version: number; view: ViewSpec; data: { source: string }; actions: PublicAction[] }

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  play: Play, square: Square, 'rotate-cw': RotateCw, 'scroll-text': ScrollText, 'trash-2': Trash2, download: Download, upload: Upload,
  power: Power, 'refresh-cw': RefreshCw, 'terminal-square': TerminalSquare, pause: Pause, info: Info,
};

const DOT: Record<string, string> = {
  green: 'bg-green-500', amber: 'bg-amber-500', red: 'bg-red-500', gray: 'bg-gray-400', blue: 'bg-blue-500',
};

type Row = Record<string, unknown>;

function formatValue(v: unknown, format: string): string {
  if (v === undefined || v === null || v === '') return '';
  const n = Number(v);
  if (format === 'bytes' && Number.isFinite(n)) {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let x = n;
    let i = 0;
    while (x >= 1024 && i < units.length - 1) { x /= 1024; i++; }
    return `${x >= 10 || i === 0 ? Math.round(x) : x.toFixed(1)} ${units[i]}`;
  }
  if ((format === 'percent' || format === 'bar') && Number.isFinite(n)) return `${Math.round(n * 10) / 10}%`;
  if (format === 'mb' && Number.isFinite(n)) return n >= 1024 ? `${(n / 1024).toFixed(1)} GB` : `${Math.round(n)} MB`;
  if (format === 'temp' && Number.isFinite(n)) return `${Math.round(n)}°C`;
  if (format === 'duration' && Number.isFinite(n)) {
    const d = Math.floor(n / 86400), h = Math.floor((n % 86400) / 3600), m = Math.floor((n % 3600) / 60);
    return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
  }
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

/** Bar colour by how full it is. */
function barColor(pct: number): string {
  return pct >= 90 ? 'bg-red-500' : pct >= 75 ? 'bg-amber-500' : 'bg-green-500';
}

function Bar({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div className="h-1.5 w-full overflow-hidden rounded bg-gray-200 dark:bg-gray-700" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <div className={`h-full ${barColor(pct)}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

/** Labelled values of one object: gauges for the ones with a `bar`, plain pairs for the rest. */
function Fields({ fields, data }: { fields: FieldSpec[]; data: Row }) {
  const shown = fields.filter(f => !f.when || evalCond(f.when, data));
  return (
    <div className="space-y-1.5">
      {shown.map(f => {
        const text = formatValue(fillTemplate(f.value, data), f.format);
        const bar = f.bar ? Number(fillTemplate(f.bar, data)) : NaN;
        return (
          <div key={f.label}>
            <div className="flex items-baseline justify-between gap-2 text-xs">
              <span className="text-gray-500">{f.label}</span>
              <span className="truncate font-medium text-gray-900 dark:text-gray-100">{text || '—'}</span>
            </div>
            {Number.isFinite(bar) && <Bar value={bar} />}
          </div>
        );
      })}
    </div>
  );
}

/** The values an action is called with: a parameter's `from` field of the row, else its default. */
function paramsFor(action: PublicAction, row: Row | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, p] of Object.entries(action.params) as [string, ParamSpec][]) {
    const fromRow = p.from && row ? getPath(row, p.from) : undefined;
    out[name] = fromRow !== undefined && fromRow !== null ? (p.type === 'number' ? Number(fromRow) : p.type === 'boolean' ? Boolean(fromRow) : String(fromRow)) : p.default;
  }
  return out;
}

interface Props {
  widgetId: string;
  widgetType: string;
  serverId: string;
}

/**
 * Renders a package widget from its declarative spec: a list, table or text view over the widget's
 * data, with the filter, toggles, summary and row actions the spec declares. Actions call the same
 * endpoint API keys use (/api/servers/:id/widget-actions/...), so they are subject to the same
 * permission, confirmation and validation rules.
 */
export function DeclarativeWidget({ widgetId, widgetType, serverId }: Props) {
  const { data, isLoading, error, refresh, unavailable } = useWidgetData(widgetId, 15);
  const { user, can } = useAuth();
  const [shellFor, setShellFor] = useState<string | null>(null);
  const [spec, setSpec] = useState<PublicSpec | null>(null);
  const [specError, setSpecError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [toggles, setToggles] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<{ action: PublicAction; row: Row | null } | null>(null);
  const [output, setOutput] = useState<{ title: string; text: string } | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await fetchWithAuth(`/api/widget-runtime/${encodeURIComponent(widgetType)}`);
        const json = await readJson<{ data?: { spec: PublicSpec }; error?: { message?: string } }>(res);
        if (!live) return;
        if (!res.ok || !json.data) { setSpecError(json.error?.message || 'This widget has no definition'); return; }
        setSpec(json.data.spec);
        setToggles(Object.fromEntries((json.data.spec.view.toggles ?? []).map(t => [t.key, t.default])));
      } catch (err) {
        if (live) setSpecError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => { live = false; };
  }, [widgetType]);

  const view = spec?.view;
  const rows: Row[] = useMemo(() => {
    if (!view || view.type === 'text' || view.type === 'fields') return [];
    const list = Array.isArray(data) ? (data as Row[]) : data && typeof data === 'object' ? [data as Row] : [];
    const q = query.trim().toLowerCase();
    return list.filter(r => {
      for (const t of view.toggles ?? []) if (!toggles[t.key] && evalCond(t.hideWhen, r)) return false;
      if (q && view.filter) return view.filter.fields.some(f => String(getPath(r, f) ?? '').toLowerCase().includes(q));
      return true;
    });
  }, [data, view, query, toggles]);

  if (specError) return <div className="p-2 text-sm text-gray-500">{specError}</div>;
  if (!spec || !view) return <WidgetLoading />;
  if (isLoading && data === null) return <WidgetLoading />;
  if (error) return <WidgetError error={error} onRetry={refresh} serverId={serverId} />;
  if (unavailable) return <div className="p-2 text-sm text-gray-500">{unavailable}</div>;
  if (data === null || data === undefined) return <div className="p-2 text-sm text-gray-500">Waiting for the first data from this host…</div>;

  const actionsById = new Map(spec.actions.map(a => [a.id, a]));
  const all: Row[] = Array.isArray(data) ? (data as Row[]) : [];

  const run = async (action: PublicAction, row: Row | null) => {
    setBusy(action.id);
    try {
      const d = await apiAction(fetchWithAuth, `/api/servers/${serverId}/widget-actions/${encodeURIComponent(widgetType)}/${encodeURIComponent(action.id)}`, 'POST', {
        params: paramsFor(action, row), ...(action.confirm ? { confirm: true } : {}),
      }) as { success: boolean; output: string; error: string; exitCode: number; timedOut: boolean };
      const text = [d.output, d.error].filter(s => s && s.trim()).join('\n').trim();
      if (!d.success) throw new Error(text.slice(0, 300) || (d.timedOut ? 'The command timed out' : `The command failed (exit ${d.exitCode})`));
      if (action.result === 'text') setOutput({ title: `${action.label}${row ? `: ${fillTemplate(view.type === 'list' ? view.row?.title ?? '' : '', row)}` : ''}`, text: text || '(no output)' });
      else if (action.result === 'toast') setNotice(`${action.label}: ${text ? text.split('\n')[0].slice(0, 120) : 'done'}`);
      if (action.after === 'refresh') setTimeout(refresh, 2500);
    } finally {
      setBusy(null);
    }
  };

  const start = (action: PublicAction, row: Row | null) => {
    if (action.kind === 'terminal') {
      const ref = action.terminal ? String(getPath(row, action.terminal.container) ?? '') : '';
      if (CONTAINER_REF_RE.test(ref)) setShellFor(ref); else setNotice(`${action.label}: this row has no usable container name`);
      return;
    }
    if (action.confirm) setPending({ action, row });
    else run(action, row).catch(err => setNotice(`${action.label} failed: ${err instanceof Error ? err.message : String(err)}`));
  };

  const rowButtons = (row: Row, ids: string[]) => ids.map(id => actionsById.get(id)).filter((a): a is PublicAction => !!a)
    // A web terminal asks for the person's own login and is only available to Full access; the action's permission still applies.
    .filter(a => can(a.permission, serverId) && (a.kind !== 'terminal' || hasRole(user?.role, 'admin')) && (!a.when || evalCond(a.when, row)))
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
      return <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all font-mono text-xs">{fillTemplate(view.text ?? '', root)}</pre>;
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
    <div className="flex h-full min-h-0 flex-col gap-2 text-sm">
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
      {notice && (
        <div className="flex items-center justify-between rounded bg-blue-50 px-2 py-1 text-xs text-blue-800 dark:bg-blue-950/50 dark:text-blue-200">
          <span className="truncate">{notice}</span>
          <button onClick={() => setNotice(null)} aria-label="Dismiss"><X className="size-3" /></button>
        </div>
      )}
      {content()}

      <ConfirmActionDialog
        open={!!pending}
        onOpenChange={o => { if (!o) setPending(null); }}
        title={pending?.action.confirm ? fillTemplate(pending.action.confirm.title, pending.row ?? {}) : ''}
        description={pending?.action.confirm?.text ? fillTemplate(pending.action.confirm.text, pending.row ?? {}) : (pending?.action.label ?? '')}
        confirmLabel={pending?.action.label ?? ''}
        destructive={!!pending?.action.confirm?.destructive}
        onConfirm={() => (pending ? run(pending.action, pending.row) : undefined)}
      />

      <Dialog.Root open={!!shellFor} onOpenChange={o => { if (!o) setShellFor(null); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
          <Dialog.Content className="fixed inset-0 z-50 flex flex-col bg-white p-2 shadow-xl dark:bg-gray-900 sm:inset-6 sm:rounded-xl sm:border sm:border-gray-700 lg:inset-x-[8%]">
            <div className="mb-2 flex items-center justify-between gap-2 px-1">
              <Dialog.Title className="truncate font-semibold">Shell: {shellFor}</Dialog.Title>
              <Dialog.Description className="sr-only">Interactive docker exec session</Dialog.Description>
              <Dialog.Close asChild><IconBtn label="Close shell"><X /></IconBtn></Dialog.Close>
            </div>
            <div className="min-h-0 flex-1">
              {shellFor && <SSHTerminalWidget widgetId={`${widgetId}:exec:${shellFor}`} serverId={serverId} containerId={shellFor} />}
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
            <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all rounded bg-gray-950 p-2 font-mono text-[11px] leading-snug text-gray-100">{output?.text}</pre>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

type IconBtnProps = React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string };

const IconBtn = forwardRef<HTMLButtonElement, IconBtnProps>(function IconBtn({ label, children, className, ...rest }, ref) {
  return (
    <button ref={ref} type="button" aria-label={label} title={label} {...rest}
      className={`rounded p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-900 disabled:opacity-40 dark:hover:bg-gray-800 dark:hover:text-gray-100 [&_svg]:size-3.5 ${className || ''}`}>
      {children}
    </button>
  );
});
