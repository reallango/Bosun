'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
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
  const [reloadToken, setReloadToken] = useState(0);
  const ctx: ViewContext = useMemo(() => ({ data, collectedAt: extra.collectedAt, state: extra.state, config: extra.config, lookups: extra.lookups, server: extra.server }), [data, extra]);
  const runner = useActionRunner({
    actions: spec?.actions ?? [], version: spec?.version ?? 1, serverId: widget.server_id, widgetType: widget.widget_type, widgetId: widget.id, templateContext: ctx,
    changed: () => { refresh(); setReloadToken(n => n + 1); },
    openScreen: id => { if (spec?.screens?.[id]?.kind === 'page') router.push(`/widgets/${encodeURIComponent(widget.id)}/${encodeURIComponent(id)}`); },
  });
  const screen = spec?.screens?.[screenId];
  const full: ViewContext = useMemo(() => ({ ...ctx, job: runner.job }), [ctx, runner.job]);
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
          : screen.kind !== 'page' ? <p className="text-sm text-muted-foreground">This screen opens as a pop-up from its widget.</p>
          : <ScreenView screen={screen} context={full} serverId={widget.server_id} widgetType={widget.widget_type} ui={ui} reloadToken={reloadToken} />}
        {runner.dialogs}
      </div>
    </>
  );
}
