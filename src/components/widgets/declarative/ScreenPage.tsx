'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft, X } from 'lucide-react';
import Header from '@/components/layout/Header';
import { LoadingSpinner } from '@/components/shared/LoadingSpinner';
import { useWidgetData } from '@/hooks/useWidgetData';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import { readJson } from '@/lib/api/readJson';
import { fillTemplate } from '@/lib/widgets/runtime/spec';
import type { ViewContext } from '@/lib/widgets/runtime/layout';
import type { LayoutUi } from './LayoutView';
import { ScreenView } from './ScreenView';
import { ScreenDialog } from './ScreenDialog';
import type { Row } from './parts';
import { useActionRunner } from './useActionRunner';
import { usePublicSpec, V1View } from './DeclarativeWidget';

interface WidgetRow { id: string; widget_type: string; server_id: string; dashboard_id: string }

/** A `page` screen of a package widget, as its own page: /widgets/:widgetId/:screenId. */
export function ScreenPage({ widgetId, screenId }: { widgetId: string; screenId: string }) {
  const [widget, setWidget] = useState<WidgetRow | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await fetchWithAuth(`/api/widgets/${encodeURIComponent(widgetId)}`);
        const json = await readJson<{ data?: { widget: WidgetRow }; error?: { message?: string } }>(res);
        if (!live) return;
        if (!res.ok || !json.data) setProblem(json.error?.message || 'Widget not found'); else setWidget(json.data.widget);
      } catch (err) { if (live) setProblem(err instanceof Error ? err.message : String(err)); }
    })();
    return () => { live = false; };
  }, [widgetId]);

  if (problem) return <><Header title="Widget" /><div className="page"><p className="text-sm text-muted-foreground">{problem}</p></div></>;
  if (!widget) return <><Header title="Widget" /><div className="page"><LoadingSpinner /></div></>;
  return <Inner widget={widget} screenId={screenId} />;
}

function Inner({ widget, screenId }: { widget: WidgetRow; screenId: string }) {
  const router = useRouter();
  const { spec, error } = usePublicSpec(widget.widget_type);
  const { data, refresh, extra } = useWidgetData(widget.id, 15);
  const jobId = useSearchParams().get('job');
  // Reopened from a task (the notification area): what was filled in, with secrets as placeholders the server resolves.
  const [restore, setRestore] = useState<{ values: Record<string, unknown>; context: Row | null; savedFrom: string } | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  useEffect(() => {
    if (!jobId) return;
    let live = true;
    (async () => {
      try {
        const res = await fetchWithAuth(`/api/widget-jobs/${encodeURIComponent(jobId)}/origin`);
        const json = await readJson<{ data?: { values: Record<string, unknown>; context: Row | null }; error?: { message?: string } }>(res);
        if (!live) return;
        if (!res.ok || !json.data) setRestoreError(json.error?.message || 'The saved values of that task are not available'); else setRestore({ values: json.data.values, context: json.data.context, savedFrom: jobId });
      } catch (e) { if (live) setRestoreError(e instanceof Error ? e.message : String(e)); }
    })();
    return () => { live = false; };
  }, [jobId]);
  const [reloadToken, setReloadToken] = useState(0);
  const [dialog, setDialog] = useState<{ id: string; row: Row | null } | null>(null);
  const ctx: ViewContext = useMemo(() => ({ data, collectedAt: extra.collectedAt, state: extra.state, config: extra.config, lookups: extra.lookups, server: extra.server }), [data, extra]);
  const runner = useActionRunner({
    actions: spec?.actions ?? [], version: spec?.version ?? 1, serverId: widget.server_id, widgetType: widget.widget_type, widgetId: widget.id, templateContext: ctx,
    changed: () => { refresh(); setReloadToken(n => n + 1); },
    openScreen: (id, row) => {
      const s = spec?.screens?.[id];
      if (!s) return;
      if (s.kind === 'page') router.push(`/widgets/${encodeURIComponent(widget.id)}/${encodeURIComponent(id)}`); else setDialog({ id, row });
    },
  });
  const screen = spec?.screens?.[screenId];
  const full: ViewContext = useMemo(() => ({ ...ctx, job: runner.job, screenId, context: restore?.context ?? undefined, restore: restore ? { values: restore.values, savedFrom: restore.savedFrom } : undefined }), [ctx, runner.job, screenId, restore]);
  const ui: LayoutUi = useMemo(() => ({
    actions: new Map((spec?.actions ?? []).map(a => [a.id, a])),
    allowed: runner.allowed, busy: runner.busy,
    onAction: (a, params) => runner.start(a, null, params),
    renderView: (v, d) => <V1View view={v} data={d} widgetId={widget.id} serverId={widget.server_id} actions={new Map((spec?.actions ?? []).map(a => [a.id, a]))} allowed={runner.allowed} busy={runner.busy} start={runner.start} />,
    onCancelJob: () => { void runner.cancelJob(); },
    submit: runner.submit,
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [spec, runner.allowed, runner.busy, runner.start, runner.submit, runner.cancelJob]);

  const title = screen ? fillTemplate(screen.title, full) : 'Widget';
  return (
    <>
      <Header title={title} />
      <div className="page max-w-7xl space-y-4">
        <Link href={`/dashboards/${encodeURIComponent(widget.dashboard_id)}`} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" aria-hidden /> Back to the dashboard
        </Link>
        {runner.notice && (
          <div className="flex items-center justify-between rounded bg-blue-50 px-3 py-2 text-sm text-blue-800 dark:bg-blue-950/50 dark:text-blue-200">
            <span className="truncate">{runner.notice}</span>
            <button onClick={() => runner.setNotice(null)} aria-label="Dismiss"><X className="size-4" /></button>
          </div>
        )}
        {error ? <p className="text-sm text-muted-foreground">{error}</p>
          : !spec ? <LoadingSpinner />
          : !screen ? <p className="text-sm text-muted-foreground">This widget has no screen called “{screenId}”.</p>
          : jobId && !restore && !restoreError ? <LoadingSpinner />
          : <>
            {restoreError && <p role="alert" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">{restoreError}. The screen is empty: fill it in again.</p>}
            {restore && <p className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-200">This is the screen of an earlier task, with what you filled in then. Passwords and tokens you entered are kept safely on the server: leave them as they are to use them again, or type new ones.</p>}
            <ScreenView screen={screen} context={full} serverId={widget.server_id} widgetType={widget.widget_type} ui={ui} reloadToken={reloadToken}
              onDone={screen.kind === 'dialog' ? () => router.push(`/dashboards/${encodeURIComponent(widget.dashboard_id)}`) : undefined} />
          </>}
        {runner.dialogs}
        <ScreenDialog id={dialog?.id ?? null} row={dialog?.row ?? null} screen={dialog ? spec?.screens?.[dialog.id] : undefined} ctx={full} serverId={widget.server_id} widgetType={widget.widget_type} ui={ui}
          reloadToken={reloadToken} onClose={() => setDialog(null)} onDone={refresh} />
      </div>
    </>
  );
}
