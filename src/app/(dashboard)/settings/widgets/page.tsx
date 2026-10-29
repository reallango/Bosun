'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, Lock, Package, RefreshCw, Trash2, Upload } from 'lucide-react';
import Header from '@/components/layout/Header';
import { Button } from '@/components/ui/button';
import { LoadingSpinner } from '@/components/shared/LoadingSpinner';
import { useToast } from '@/components/ui/toast';
import { useAuth } from '@/hooks/useAuth';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import { readJson } from '@/lib/api/readJson';

interface InstalledItem {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  system: boolean;
  source: 'system' | 'github' | 'upload' | 'bundled';
  sourceRef: string | null;
  widgetTypes: string[];
  permissions: string[];
}

interface AvailableItem {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  widgetTypes: string[];
  permissions: string[];
  installedVersion: string | null;
  upgradable: boolean;
  review: PackageReview;
}

interface PackageReview {
  widgets: { type: string; name: string; commands: { what: string; as: 'service' | 'shell' | 'terminal'; command: string; windowsCommand?: string; permission?: string; confirm: boolean }[] }[];
  permissions: { id: string; label: string; risk: string; defaultLevel: string }[];
  runsAsService: boolean;
  commandCount: number;
}

/** What the admin confirms before a package is installed. */
type Reviewing =
  | { kind: 'github'; id: string; name: string; version: string; upgrade: boolean; review: PackageReview }
  | { kind: 'zip'; file: File; name: string; version: string; installedVersion: string | null; review: PackageReview };

interface SourceInfo { repo: string; ref: string; refs: string[] }

type ApiResult<T> = { data?: T; error?: { message?: string; code?: string } };

class ApiError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetchWithAuth(url, init);
  const json = await readJson<ApiResult<T>>(res);
  if (!res.ok || json.error) throw new ApiError(json.error?.message || `HTTP ${res.status}`, json.error?.code);
  return json.data as T;
}

const errText = (err: unknown) => (err instanceof Error ? err.message : undefined);

/**
 * Settings → Widgets: widget packages. Available packages (the `widgets/` folder of the Bosun
 * repository on the chosen branch) are on the left, installed ones on the right. System widgets
 * are built in: they show their version but cannot be removed or upgraded here.
 */
export default function WidgetPackagesPage() {
  const { toast } = useToast();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const fileRef = useRef<HTMLInputElement>(null);

  const [installed, setInstalled] = useState<InstalledItem[]>([]);
  const [source, setSource] = useState<SourceInfo | null>(null);
  const [available, setAvailable] = useState<AvailableItem[]>([]);
  const [skipped, setSkipped] = useState<{ dir: string; error: string }[]>([]);
  const [availableError, setAvailableError] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingAvailable, setLoadingAvailable] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState<Reviewing | null>(null);

  const askInstall = (p: AvailableItem, upgrade: boolean) => {
    if (p.review.commandCount === 0) install(p.id, upgrade);
    else setReviewing({ kind: 'github', id: p.id, name: p.name, version: p.version, upgrade, review: p.review });
  };

  const loadInstalled = useCallback(async () => {
    try {
      const d = await api<{ installed: InstalledItem[]; source: SourceInfo }>('/api/widget-packages');
      setInstalled(d.installed);
      setSource(d.source);
    } catch (err) {
      toast('Failed to load widget packages', { variant: 'error', description: errText(err) });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  const loadAvailable = useCallback(async (refresh = false) => {
    setLoadingAvailable(true);
    setAvailableError('');
    try {
      const d = await api<{ packages: AvailableItem[]; skipped: { dir: string; error: string }[] }>(`/api/widget-packages/available${refresh ? '?refresh=1' : ''}`);
      setAvailable(d.packages);
      setSkipped(d.skipped);
    } catch (err) {
      setAvailable([]);
      setSkipped([]);
      setAvailableError(errText(err) || 'Could not load the list');
    } finally {
      setLoadingAvailable(false);
    }
  }, []);

  useEffect(() => { if (isAdmin) { loadInstalled(); loadAvailable(); } else setLoading(false); }, [isAdmin, loadInstalled, loadAvailable]);

  const refreshAll = async (forceRemote = false) => {
    await Promise.all([loadInstalled(), loadAvailable(forceRemote)]);
  };

  const changeRef = async (ref: string) => {
    setBusy('ref');
    try {
      await api('/api/widget-packages/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ref }) });
      await refreshAll(true);
    } catch (err) {
      toast('Could not change the branch', { variant: 'error', description: errText(err) });
    } finally {
      setBusy(null);
    }
  };

  const install = async (id: string, upgrade: boolean) => {
    setBusy(id);
    try {
      await api('/api/widget-packages/install', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
      toast(upgrade ? 'Package upgraded' : 'Package installed', { variant: 'success' });
      await refreshAll();
    } catch (err) {
      toast(upgrade ? 'Upgrade failed' : 'Install failed', { variant: 'error', description: errText(err) });
    } finally {
      setBusy(null);
    }
  };

  // Zip imports are checked first (dry run) so the admin can review what the package runs before anything is installed.
  const previewZip = async (file: File) => {
    setBusy('import');
    try {
      const r = await api<{ name: string; version: string; installedVersion: string | null; review: PackageReview }>('/api/widget-packages/import?dry_run=1', {
        method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: file,
      });
      if (r.review.commandCount === 0) { setBusy(null); await importZip(file); return; }
      setReviewing({ kind: 'zip', file, name: r.name, version: r.version, installedVersion: r.installedVersion, review: r.review });
    } catch (err) {
      toast('Import failed', { variant: 'error', description: errText(err) });
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const confirmReview = async () => {
    const r = reviewing;
    setReviewing(null);
    if (!r) return;
    if (r.kind === 'github') await install(r.id, r.upgrade);
    else await importZip(r.file, r.installedVersion !== null);
  };

  const importZip = async (file: File, replace = false): Promise<void> => {
    setBusy('import');
    try {
      const r = await api<{ id: string; version: string }>(`/api/widget-packages/import${replace ? '?replace=1' : ''}`, {
        method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: file,
      });
      toast(`Imported ${r.id} ${r.version}`, { variant: 'success' });
      await refreshAll();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'NOT_NEWER' && !replace && window.confirm(`${err.message}\n\nReplace the installed version with this one anyway?`)) {
        setBusy(null);
        return importZip(file, true);
      }
      toast('Import failed', { variant: 'error', description: errText(err) });
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const remove = async (id: string, withWidgets: boolean) => {
    setBusy(id);
    try {
      const r = await api<{ removedWidgets: number }>(`/api/widget-packages/${encodeURIComponent(id)}${withWidgets ? '?remove_widgets=1' : ''}`, { method: 'DELETE' });
      toast(r.removedWidgets ? `Package removed with ${r.removedWidgets} widget${r.removedWidgets === 1 ? '' : 's'}` : 'Package removed', { variant: 'success' });
      setConfirmRemove(null);
      await refreshAll();
    } catch (err) {
      toast('Remove failed', { variant: 'error', description: errText(err) });
    } finally {
      setBusy(null);
    }
  };

  const system = installed.filter(p => p.system);
  const added = installed.filter(p => !p.system);

  if (!isAdmin && !loading) {
    return (
      <>
        <Header title="Widgets" />
        <div className="page max-w-5xl"><p className="text-sm text-muted-foreground">Managing widget packages needs Full access.</p></div>
      </>
    );
  }

  return (
    <>
      <Header title="Widgets" />
      <div className="page max-w-6xl space-y-4">
        <p className="text-sm text-muted-foreground">
          Widget packages add widgets and the permissions they need. Available packages come from the <code className="rounded bg-muted px-1">widgets/</code> folder
          of the Bosun repository; you can also import a package zip. System widgets are built in to Bosun.
        </p>

        <div className="flex flex-wrap items-center gap-3 rounded-xl border bg-card p-3 text-sm">
          <label className="flex items-center gap-2">
            Source branch
            <select className="form-select h-8 w-auto" value={source?.ref ?? 'main'} disabled={busy !== null || !source} onChange={e => changeRef(e.target.value)} aria-label="Source branch">
              {(source?.refs ?? ['main', 'dev']).map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          </label>
          <span className="text-xs text-muted-foreground">{source?.repo}</span>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => refreshAll(true)} disabled={busy !== null || loadingAvailable}>
              <RefreshCw className={loadingAvailable ? 'animate-spin motion-reduce:animate-none' : ''} /> Refresh
            </Button>
            <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()} disabled={busy !== null}>
              <Upload /> Import zip
            </Button>
            <input ref={fileRef} type="file" accept=".zip,application/zip" className="sr-only" aria-label="Import a widget package zip"
              onChange={e => { const f = e.target.files?.[0]; if (f) previewZip(f); }} />
          </div>
        </div>

        {reviewing && (
          <section className="space-y-3 rounded-xl border border-amber-500/50 bg-amber-500/5 p-4 text-sm" role="alertdialog" aria-label={`Review ${reviewing.name} before installing`}>
            <h2 className="font-semibold">
              Review {reviewing.name} v{reviewing.version} before installing
            </h2>
            <p className="text-muted-foreground">
              This package runs commands on your servers, from widgets or when someone with the matching permission uses an action.
              {reviewing.review.runsAsService && <> Some run as the <strong>privileged service account</strong> (unrestricted sudo).</>} Only install packages you trust.
            </p>
            {reviewing.review.widgets.map(w => (
              <div key={w.type} className="space-y-1.5">
                <div className="font-medium">{w.name} <code className="rounded bg-muted px-1 text-xs">{w.type}</code></div>
                <ul className="space-y-1.5">
                  {w.commands.map((c, i) => (
                    <li key={i} className="rounded-lg bg-muted/60 p-2">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="font-medium">{c.what}</span>
                        <span className={`rounded px-1 uppercase ${c.as === 'service' ? 'bg-amber-500/20 text-amber-700 dark:text-amber-400' : 'bg-muted text-muted-foreground'}`}>
                          {c.as === 'service' ? 'service account' : c.as === 'terminal' ? 'web terminal' : 'non-admin account'}
                        </span>
                        {c.permission && <span className="text-muted-foreground">needs <code>{c.permission}</code></span>}
                        {c.confirm && <span className="text-muted-foreground">asks to confirm</span>}
                      </div>
                      <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs">{c.command}</pre>
                      {c.windowsCommand && <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs"><span className="text-muted-foreground">Windows: </span>{c.windowsCommand}</pre>}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            {reviewing.review.permissions.length > 0 && (
              <p className="text-xs text-muted-foreground">
                Adds permissions: {reviewing.review.permissions.map(p => `${p.label} (${p.risk} risk)`).join(', ')}. Nobody holds them until you grant them in a permission group.
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={confirmReview} disabled={busy !== null}>
                {reviewing.kind === 'github' ? (reviewing.upgrade ? 'Upgrade' : 'Install') : reviewing.installedVersion ? 'Replace installed version' : 'Install'}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setReviewing(null)}>Cancel</Button>
            </div>
          </section>
        )}

        {loading ? <LoadingSpinner /> : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <section aria-labelledby="available-h" className="space-y-3">
              <h2 id="available-h" className="text-sm font-semibold">Available</h2>
              {loadingAvailable && available.length === 0 ? <LoadingSpinner /> : availableError ? (
                <div className="rounded-xl border border-dashed p-4 text-sm text-destructive" role="alert">{availableError}</div>
              ) : available.length === 0 ? (
                <div className="rounded-xl border border-dashed py-10 text-center text-sm text-muted-foreground">
                  No packages on the <strong>{source?.ref}</strong> branch yet
                </div>
              ) : (
                <ul className="space-y-3">
                  {available.map(p => (
                    <li key={p.id} className="rounded-xl border bg-card p-4">
                      <div className="flex flex-wrap items-start gap-3">
                        <Package className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium">{p.name}</span>
                            <span className="rounded bg-muted px-1 text-xs">v{p.version}</span>
                            {p.installedVersion && !p.upgradable && <span className="rounded bg-green-500/15 px-1 text-[10px] uppercase text-green-700 dark:text-green-400">installed</span>}
                          </div>
                          {p.description && <p className="mt-0.5 text-sm text-muted-foreground">{p.description}</p>}
                          <p className="mt-1 text-xs text-muted-foreground">
                            {p.widgetTypes.length} widget{p.widgetTypes.length === 1 ? '' : 's'}
                            {p.permissions.length > 0 && <> · adds {p.permissions.length} permission{p.permissions.length === 1 ? '' : 's'}</>}
                            {p.author && <> · {p.author}</>}
                          </p>
                        </div>
                        {p.upgradable ? (
                          <Button size="sm" onClick={() => askInstall(p, true)} disabled={busy !== null}>
                            {busy === p.id ? 'Upgrading…' : `Upgrade from ${p.installedVersion}`}
                          </Button>
                        ) : !p.installedVersion ? (
                          <Button size="sm" onClick={() => askInstall(p, false)} disabled={busy !== null}>
                            {busy === p.id ? 'Installing…' : 'Install'}
                          </Button>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              {skipped.length > 0 && (
                <details className="rounded-xl border p-3 text-xs text-muted-foreground">
                  <summary className="cursor-pointer">{skipped.length} package{skipped.length === 1 ? '' : 's'} skipped (not valid)</summary>
                  <ul className="mt-2 space-y-1">
                    {skipped.map(s => <li key={s.dir}><code>{s.dir}</code>: {s.error}</li>)}
                  </ul>
                </details>
              )}
            </section>

            <section aria-labelledby="installed-h" className="space-y-3">
              <h2 id="installed-h" className="text-sm font-semibold">Installed</h2>
              {added.length > 0 && (
                <ul className="space-y-3">
                  {added.map(p => (
                    <li key={p.id} className="rounded-xl border bg-card p-4">
                      <div className="flex flex-wrap items-start gap-3">
                        <Package className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium">{p.name}</span>
                            <span className="rounded bg-muted px-1 text-xs">v{p.version}</span>
                            <span className="rounded bg-muted px-1 text-[10px] uppercase text-muted-foreground">{p.source === 'github' ? `github:${p.sourceRef}` : p.source === 'bundled' ? 'preinstalled' : 'zip import'}</span>
                          </div>
                          {p.description && <p className="mt-0.5 text-sm text-muted-foreground">{p.description}</p>}
                          <p className="mt-1 text-xs text-muted-foreground">
                            {p.widgetTypes.join(', ')}
                            {p.permissions.length > 0 && <> · {p.permissions.length} permission{p.permissions.length === 1 ? '' : 's'}</>}
                          </p>
                        </div>
                        <div className="flex items-center gap-1">
                          <a className="inline-flex size-8 items-center justify-center rounded-md hover:bg-muted" href={`/api/widget-packages/${encodeURIComponent(p.id)}/export`} download aria-label={`Export ${p.name}`} title="Export zip">
                            <Download className="size-4" />
                          </a>
                          <Button variant="ghost" size="icon-sm" onClick={() => setConfirmRemove(confirmRemove === p.id ? null : p.id)} disabled={busy !== null} aria-label={`Remove ${p.name}`}>
                            <Trash2 className="text-destructive" />
                          </Button>
                        </div>
                      </div>
                      {confirmRemove === p.id && (
                        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg bg-muted p-2 text-sm" role="alertdialog" aria-label={`Confirm removing ${p.name}`}>
                          <span className="min-w-0 flex-1">Remove <strong>{p.name}</strong>? Its permissions and any dashboard widgets that use it are removed too.</span>
                          <Button variant="destructive" size="sm" onClick={() => remove(p.id, true)} disabled={busy !== null}>{busy === p.id ? 'Removing…' : 'Remove'}</Button>
                          <Button variant="outline" size="sm" onClick={() => setConfirmRemove(null)}>Cancel</Button>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {added.length === 0 && (
                <div className="rounded-xl border border-dashed py-6 text-center text-sm text-muted-foreground">No packages installed yet</div>
              )}

              <h3 className="pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">System widgets (built in)</h3>
              <ul className="divide-y rounded-xl border bg-card">
                {system.map(p => (
                  <li key={p.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-sm">
                    <Lock className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="font-medium">{p.name}</span>
                    <span className="rounded bg-muted px-1 text-xs">v{p.version}</span>
                    <span className="rounded bg-primary/10 px-1 text-[10px] uppercase text-primary">system</span>
                    <span className="min-w-0 basis-full text-xs text-muted-foreground sm:basis-auto sm:flex-1">{p.description}</span>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground">System widgets update with Bosun itself and cannot be removed or replaced by a package.</p>
            </section>
          </div>
        )}
      </div>
    </>
  );
}
