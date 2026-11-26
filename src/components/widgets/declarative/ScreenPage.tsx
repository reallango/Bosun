'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Header from '@/components/layout/Header';
import { LoadingSpinner } from '@/components/shared/LoadingSpinner';
import { useWidgetData } from '@/hooks/useWidgetData';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import { readJson } from '@/lib/api/readJson';
import { fillTemplate } from '@/lib/widgets/runtime/spec';
import type { ViewContext } from '@/lib/widgets/runtime/layout';
import { ActionRunnerToasts } from '@/components/widgets/shared/ActionRunnerToasts';
import { JobProgressBar } from '@/components/widgets/shared/JobProgressBar';
import { PageBreadcrumb } from '@/components/widgets/shared/PageBreadcrumb';
import { RefreshAge } from '@/components/widgets/shared/RefreshAge';
import { WidgetInstanceSwitcher } from '@/components/widgets/shared/WidgetInstanceSwitcher';
import type { WidgetInstance } from '@/components/widgets/shared/screen-page';
import type { LayoutUi } from './LayoutView';
import { ScreenView } from './ScreenView';
import { ScreenDialog } from './ScreenDialog';
import { RowSheet } from './RowSheet';
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

  if (problem) return <><Header title="Widget" hideBreadcrumb /><div className="page"><p className="text-sm text-muted-foreground">{problem}</p></div></>;
  if (!widget) return <><Header title="Widget" hideBreadcrumb /><div className="page"><LoadingSpinner /></div></>;
  return <Inner key={`${widget.id}:${screenId}`} widget={widget} screenId={screenId} />;
}

function Inner({ widget, screenId }: { widget: WidgetRow; screenId: string }) {
  const router = useRouter();
  const { spec, error } = usePublicSpec(widget.widget_type);
  const { data, refresh, extra } = useWidgetData(widget.id, 15);
  const jobId = useSearchParams().get('job');

  // Every placement of this widget type the person may open, for the server switcher and the dashboard's name.
  const [instances, setInstances] = useState<WidgetInstance[]>([]);
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await fetchWithAuth(`/api/widgets/instances?type=${encodeURIComponent(widget.widget_type)}`);
        const json = await readJson<{ data?: { instances?: WidgetInstance[] } }>(res);
        if (live && res.ok && json.data) setInstances(Array.isArray(json.data.instances) ? json.data.instances : []);
      } catch { /* the switcher is an extra: the screen works without it */ }
    })();
    return () => { live = false; };
  }, [widget.widget_type]);
  const currentInstance = instances.find(i => i.id === widget.id) ?? null;

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
  const [screenStatus, setScreenStatus] = useState<{ loadedAt: number; loading: boolean }>({ loadedAt: 0, loading: false });
  const [dialog, setDialog] = useState<{ id: string; row: Row | null } | null>(null);
  // A row's details, opened by clicking a table/list row whose view names a screen with `open` (shown in a side sheet).
  const [detail, setDetail] = useState<{ id: string; row: Row } | null>(null);
  // The widget's data carries the server; until it arrives the name from the instances list fills the screen title.
  const serverFallback = useMemo(() => (currentInstance?.server_name ? { name: currentInstance.server_name } : undefined), [currentInstance?.server_name]);
  const ctx: ViewContext = useMemo(() => ({ data, collectedAt: extra.collectedAt, state: extra.state, config: extra.config, lookups: extra.lookups, server: extra.server ? { ...serverFallback, ...extra.server } : serverFallback }), [data, extra, serverFallback]);

  /** Reload the widget's data and the screen's datasets, the same way an action that changed the host does. */
  const reloadScreen = useCallback(() => {
    void refresh();
    setReloadToken(n => n + 1);
  }, [refresh]);

  const runner = useActionRunner({
    actions: spec?.actions ?? [], version: spec?.version ?? 1, serverId: widget.server_id, widgetType: widget.widget_type, widgetId: widget.id, templateContext: ctx,
    changed: reloadScreen,
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
    renderView: (v, d) => <V1View view={v} data={d} widgetId={widget.id} serverId={widget.server_id} actions={new Map((spec?.actions ?? []).map(a => [a.id, a]))} allowed={runner.allowed} busy={runner.busy} start={runner.start}
      openRow={(id, row) => { if (spec?.screens?.[id]) setDetail({ id, row }); }} />,
    onCancelJob: () => { void runner.cancelJob(); },
    submit: runner.submit,
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [spec, runner.allowed, runner.busy, runner.start, runner.submit, runner.cancelJob]);

  const title = screen ? fillTemplate(screen.title, full) : 'Widget';
  const dashboardName = currentInstance?.dashboard_name ?? 'Dashboard';
  const setNotice = runner.setNotice;
  const clearNotice = useCallback(() => setNotice(null), [setNotice]);
  const onScreenStatus = useCallback((s: { loadedAt: number; loading: boolean }) => {
    setScreenStatus(prev => (prev.loadedAt === s.loadedAt && prev.loading === s.loading ? prev : s));
  }, []);
  const openInstance = useCallback((id: string) => {
    if (id === widget.id) return;
    router.push(`/widgets/${encodeURIComponent(id)}/${encodeURIComponent(screenId)}`);
  }, [router, widget.id, screenId]);

  return (
    <>
      <Header title={title} hideBreadcrumb />
      <JobProgressBar job={runner.job} label={title} />
      <div className="page max-w-7xl space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
            <PageBreadcrumb items={[
              { label: dashboardName, href: `/dashboards/${encodeURIComponent(widget.dashboard_id)}` },
              { label: title },
            ]} />
            <WidgetInstanceSwitcher instances={instances} currentId={widget.id} onOpen={openInstance} />
          </div>
          <RefreshAge loadedAt={screenStatus.loadedAt} loading={screenStatus.loading} onRefresh={reloadScreen} />
        </div>
        <ActionRunnerToasts notice={runner.notice} onShown={clearNotice} />
        {error ? <p className="text-sm text-muted-foreground">{error}</p>
          : !spec ? <LoadingSpinner />
          : !screen ? <p className="text-sm text-muted-foreground">This widget has no screen called â€œ{screenId}â€.</p>
          : jobId && !restore && !restoreError ? <LoadingSpinner />
          : <>
            {restoreError && <p role="alert" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">{restoreError}. The screen is empty: fill it in again.</p>}
            {restore && <p className="rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-sm text-primary">This is the screen of an earlier task, with what you filled in then. Passwords and tokens you entered are kept safely on the server: leave them as they are to use them again, or type new ones.</p>}
            <ScreenView screen={screen} context={full} serverId={widget.server_id} widgetType={widget.widget_type} ui={ui} reloadToken={reloadToken} hideReload onStatus={onScreenStatus}
              onDone={screen.kind === 'dialog' ? () => router.push(`/dashboards/${encodeURIComponent(widget.dashboard_id)}`) : undefined} />
          </>}
        {runner.dialogs}
        <ScreenDialog id={dialog?.id ?? null} row={dialog?.row ?? null} screen={dialog ? spec?.screens?.[dialog.id] : undefined} ctx={full} serverId={widget.server_id} widgetType={widget.widget_type} ui={ui}
          reloadToken={reloadToken} onClose={() => setDialog(null)} onDone={refresh} />
        <RowSheet id={detail?.id ?? null} row={detail?.row ?? null} screen={detail ? spec?.screens?.[detail.id] : undefined} ctx={full} serverId={widget.server_id} widgetType={widget.widget_type} ui={ui}
          reloadToken={reloadToken} onClose={() => setDetail(null)} onDone={refresh} />
      </div>
    </>
  );
}
