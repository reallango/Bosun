'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import { readJson } from '@/lib/api/readJson';
import type { ScreenSpec } from '@/lib/widgets/runtime/spec-screens';
import { screenArgs, text, type PublicActionLike, type ViewContext } from '@/lib/widgets/runtime/layout';
import { LayoutBlocks, type LayoutUi } from './LayoutView';

type Datasets = Record<string, unknown>;

/**
 * Loads the datasets a screen asks for (POST /api/servers/:id/widget-datasets/:type/:dataset), each with the arguments its
 * `load` entry takes from the screen's context. `reload` loads them again (after something was changed).
 */
export function useScreenDatasets(serverId: string, widgetType: string, screen: ScreenSpec | null, context: ViewContext) {
  const [datasets, setDatasets] = useState<Datasets>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [loadedAt, setLoadedAt] = useState(0);
  const key = JSON.stringify(Object.entries(screen?.load ?? {}).map(([alias, l]) => [alias, l.dataset, screenArgs(l.args, context)]));

  const load = useCallback(async () => {
    if (!screen) return;
    const entries = Object.entries(screen.load);
    if (!entries.length) { setLoadedAt(Date.now()); return; }
    setLoading(true);
    const next: Datasets = {};
    const errs: Record<string, string> = {};
    await Promise.all(entries.map(async ([alias, l]) => {
      try {
        const res = await fetchWithAuth(`/api/servers/${serverId}/widget-datasets/${encodeURIComponent(widgetType)}/${encodeURIComponent(l.dataset)}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ args: screenArgs(l.args, context) }),
        });
        const json = await readJson<{ data?: { data: unknown }; error?: { message?: string } }>(res);
        if (!res.ok || !json.data) errs[alias] = json.error?.message || `HTTP ${res.status}`;
        else next[alias] = json.data.data;
      } catch (err) {
        errs[alias] = err instanceof Error ? err.message : String(err);
      }
    }));
    setDatasets(next);
    setErrors(errs);
    setLoading(false);
    setLoadedAt(Date.now());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId, widgetType, screen, key]);

  useEffect(() => { void load(); }, [load]);
  return { datasets, errors, loading, loadedAt, reload: load };
}

interface Props {
  screen: ScreenSpec;
  context: ViewContext;
  serverId: string;
  widgetType: string;
  ui: LayoutUi;
  /** Called after an editor's submit succeeded (a dialog closes itself). */
  onDone?: () => void;
  /** Reload the screen's datasets whenever this changes (an action changed something). */
  reloadToken?: number;
}

/** The body of a screen: its datasets, then its blocks. Shared by the pop-up and the full page. */
export function ScreenView({ screen, context, serverId, widgetType, ui, onDone, reloadToken }: Props) {
  const { datasets, errors, loading, loadedAt, reload } = useScreenDatasets(serverId, widgetType, screen, context);
  useEffect(() => { if (reloadToken) void reload(); }, [reloadToken, reload]);
  const ctx: ViewContext = useMemo(() => ({ ...context, datasets }), [context, datasets]);
  const screenUi: LayoutUi = useMemo(() => ({
    ...ui,
    large: true,
    onSubmitted: ok => { if (ok) { onDone?.(); void reload(); } },
  }), [ui, onDone, reload]);
  const failed = Object.entries(errors);
  const waiting = loading && loadedAt === 0;
  return (
    <div className="space-y-3">
      {screen.description && <p className="text-sm text-gray-600 dark:text-gray-400">{text(screen.description, ctx)}</p>}
      {failed.map(([alias, msg]) => (
        <div key={alias} role="alert" className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">{msg}</div>
      ))}
      {waiting ? (
        <div className="flex items-center gap-2 py-6 text-sm text-gray-500"><Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden /> Loading from the host…</div>
      ) : (
        <div>
          {screen.kind === 'page' && Object.keys(screen.load).length > 0 && (
            <div className="mb-2 flex justify-end">
              <button type="button" onClick={() => void reload()} disabled={loading}
                className="inline-flex items-center gap-1 rounded-md border border-gray-200 px-2 py-1 text-xs hover:bg-gray-100 disabled:opacity-40 dark:border-gray-700 dark:hover:bg-gray-800">
                <RefreshCw className={`size-3 ${loading ? 'animate-spin motion-reduce:animate-none' : ''}`} aria-hidden /> Reload
              </button>
            </div>
          )}
          <LayoutBlocks blocks={screen.blocks} ctx={ctx} ui={screenUi} />
        </div>
      )}
    </div>
  );
}

export type { PublicActionLike };
