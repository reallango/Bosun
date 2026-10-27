'use client';

import { forwardRef, useMemo, useState } from 'react';
import { Dialog } from 'radix-ui';
import { Play, Square, RotateCw, TerminalSquare, ScrollText, Search, X, Loader2 } from 'lucide-react';
import { useWidgetData } from '@/hooks/useWidgetData';
import { useAuth } from '@/hooks/useAuth';
import { hasRole } from '@/lib/auth/levels';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import { WidgetLoading } from '@/components/widgets/WidgetLoading';
import { WidgetError } from '@/components/widgets/WidgetError';
import dynamic from 'next/dynamic';
import { ConfirmActionDialog, apiAction } from '@/components/widgets/shared/ConfirmActionDialog';

// The terminal (xterm) loads only when a container shell is opened.
const SSHTerminalWidget = dynamic(
  () => import('@/components/widgets/ssh-terminal').then(m => m.SSHTerminalWidget),
  { ssr: false, loading: () => <WidgetLoading /> },
);

interface Container {
  id: string;
  name: string;
  image: string;
  status: string;
  state: string;
  ports: string;
  compose?: string | null;
}

interface DockerData {
  available: boolean;
  error?: string;
  containers: Container[];
}

type Action = 'start' | 'stop' | 'restart';

const STATE_DOT: Record<string, string> = {
  running: 'bg-green-500',
  restarting: 'bg-amber-500 animate-pulse',
  paused: 'bg-amber-500',
  created: 'bg-gray-400',
  exited: 'bg-gray-400',
  dead: 'bg-red-500',
};

interface Props {
  widgetId: string;
  serverId: string;
}

export function DockerContainersWidget({ widgetId, serverId }: Props) {
  const { data, isLoading, error, refresh } = useWidgetData(widgetId, 15);
  const { user } = useAuth();
  // Read + actions: logs and start/stop/restart. Shells need Full access.
  const canAct = hasRole(user?.role, 'operator');
  const canShell = hasRole(user?.role, 'admin');
  const [query, setQuery] = useState('');
  const [showStopped, setShowStopped] = useState(true);
  const [pending, setPending] = useState<{ c: Container; action: Action } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [shellFor, setShellFor] = useState<Container | null>(null);
  const [logsFor, setLogsFor] = useState<Container | null>(null);
  const [logs, setLogs] = useState<string>('');
  const [logsLoading, setLogsLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const docker = data as DockerData | null;
  const containers = useMemo(() => {
    const list = docker?.containers ?? [];
    const q = query.trim().toLowerCase();
    return list.filter(c =>
      (showStopped || c.state === 'running') &&
      (!q || c.name.toLowerCase().includes(q) || c.image.toLowerCase().includes(q) || (c.compose || '').toLowerCase().includes(q)));
  }, [docker, query, showStopped]);

  if (isLoading && !data) return <WidgetLoading />;
  if (error) return <WidgetError error={error} onRetry={refresh} serverId={serverId} />;
  if (!docker) return <div className="p-2 text-sm text-gray-500">Waiting for the first poll of this host…</div>;
  if (!docker.available) {
    return <div className="p-2 text-sm text-gray-500">Docker unavailable: {docker.error || 'not installed'}</div>;
  }

  const running = docker.containers.filter(c => c.state === 'running').length;

  const runAction = async (c: Container, action: Action) => {
    setBusy(c.id);
    try {
      await apiAction(fetchWithAuth, `/api/servers/${serverId}/containers/${encodeURIComponent(c.name)}/action`, 'POST', { action, confirm: true });
      setNotice(`${action} ${c.name}: done`);
      setTimeout(refresh, 2500);
    } finally {
      setBusy(null);
    }
  };

  const openLogs = async (c: Container) => {
    setLogsFor(c);
    setLogs('');
    setLogsLoading(true);
    try {
      const d = await apiAction(fetchWithAuth, `/api/servers/${serverId}/containers/${encodeURIComponent(c.name)}/logs?tail=300`, 'GET') as { logs: string };
      setLogs(d.logs || '(no output)');
    } catch (err) {
      setLogs(`Failed to load logs: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLogsLoading(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-gray-500">
          <span className="font-semibold text-gray-900 dark:text-gray-100">{running}</span> running / {docker.containers.length}
        </span>
        <div className="relative ml-auto min-w-0 flex-1 basis-32 sm:max-w-[220px]">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-gray-400" aria-hidden />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Filter"
            aria-label="Filter containers"
            className="w-full rounded-md border border-gray-200 bg-transparent py-1 pl-7 pr-2 text-xs outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-700"
          />
        </div>
        <label className="flex items-center gap-1 text-xs text-gray-500">
          <input type="checkbox" checked={showStopped} onChange={e => setShowStopped(e.target.checked)} /> stopped
        </label>
      </div>
      {notice && (
        <div className="flex items-center justify-between rounded bg-blue-50 px-2 py-1 text-xs text-blue-800 dark:bg-blue-950/50 dark:text-blue-200">
          <span className="truncate">{notice}</span>
          <button onClick={() => setNotice(null)} aria-label="Dismiss"><X className="size-3" /></button>
        </div>
      )}
      <ul className="min-h-0 flex-1 divide-y divide-gray-100 overflow-auto dark:divide-gray-800">
        {containers.map(c => (
          <li key={c.id} className="flex items-center gap-2 py-1.5">
            <span className={`size-2 shrink-0 rounded-full ${STATE_DOT[c.state] || 'bg-gray-400'}`} title={c.state} aria-label={c.state} />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className="truncate font-medium">{c.name}</span>
                {c.compose && <span className="hidden truncate rounded bg-gray-100 px-1 text-[10px] text-gray-500 dark:bg-gray-800 sm:inline">{c.compose}</span>}
              </div>
              <div className="truncate text-xs text-gray-500" title={`${c.image} · ${c.status}${c.ports ? ` · ${c.ports}` : ''}`}>
                {c.image} · {c.status}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-0.5">
              {busy === c.id && <Loader2 className="size-4 animate-spin text-gray-400" aria-label="Working" />}
              {canAct && (
                <IconBtn label={`Logs for ${c.name}`} onClick={() => openLogs(c)}><ScrollText /></IconBtn>
              )}
              {canAct && c.state === 'running' && (
                <>
                  {canShell && <IconBtn label={`Shell in ${c.name}`} onClick={() => setShellFor(c)}><TerminalSquare /></IconBtn>}
                  <IconBtn label={`Restart ${c.name}`} onClick={() => setPending({ c, action: 'restart' })} disabled={!!busy}><RotateCw /></IconBtn>
                  <IconBtn label={`Stop ${c.name}`} onClick={() => setPending({ c, action: 'stop' })} disabled={!!busy} danger><Square /></IconBtn>
                </>
              )}
              {canAct && c.state !== 'running' && (
                <IconBtn label={`Start ${c.name}`} onClick={() => setPending({ c, action: 'start' })} disabled={!!busy}><Play /></IconBtn>
              )}
            </div>
          </li>
        ))}
        {containers.length === 0 && <li className="py-4 text-center text-xs text-gray-500">No containers match</li>}
      </ul>

      <ConfirmActionDialog
        open={!!pending}
        onOpenChange={o => { if (!o) setPending(null); }}
        title={pending ? `${pending.action[0].toUpperCase()}${pending.action.slice(1)} ${pending.c.name}?` : ''}
        description={pending && (
          <>This runs <code className="font-mono">docker {pending.action} {pending.c.name}</code> on the host.
            {pending.action !== 'start' && ' Anything the container is serving will be interrupted.'}</>
        )}
        confirmLabel={pending ? pending.action[0].toUpperCase() + pending.action.slice(1) : ''}
        destructive={pending?.action !== 'start'}
        onConfirm={() => (pending ? runAction(pending.c, pending.action) : undefined)}
      />

      <Dialog.Root open={!!logsFor} onOpenChange={o => { if (!o) setLogsFor(null); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
          <Dialog.Content className="fixed inset-2 z-50 flex flex-col rounded-xl border border-gray-200 bg-white p-3 shadow-xl dark:border-gray-700 dark:bg-gray-900 sm:inset-8 lg:inset-x-[10%]">
            <div className="mb-2 flex items-center justify-between gap-2">
              <Dialog.Title className="truncate font-semibold">Logs: {logsFor?.name}</Dialog.Title>
              <Dialog.Description className="sr-only">Last 300 log lines of the container</Dialog.Description>
              <div className="flex gap-1">
                <IconBtn label="Reload logs" onClick={() => logsFor && openLogs(logsFor)}><RotateCw /></IconBtn>
                <Dialog.Close asChild><IconBtn label="Close"><X /></IconBtn></Dialog.Close>
              </div>
            </div>
            <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all rounded bg-gray-950 p-2 font-mono text-[11px] leading-snug text-gray-100">
              {logsLoading ? 'Loading…' : logs}
            </pre>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={!!shellFor} onOpenChange={o => { if (!o) setShellFor(null); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
          <Dialog.Content className="fixed inset-0 z-50 flex flex-col bg-white p-2 shadow-xl dark:bg-gray-900 sm:inset-6 sm:rounded-xl sm:border sm:border-gray-700 lg:inset-x-[8%]">
            <div className="mb-2 flex items-center justify-between gap-2 px-1">
              <Dialog.Title className="truncate font-semibold">Shell: {shellFor?.name}</Dialog.Title>
              <Dialog.Description className="sr-only">Interactive docker exec session</Dialog.Description>
              <Dialog.Close asChild><IconBtn label="Close shell"><X /></IconBtn></Dialog.Close>
            </div>
            <div className="min-h-0 flex-1">
              {shellFor && (
                <SSHTerminalWidget widgetId={`${widgetId}:exec:${shellFor.name}`} serverId={serverId} containerId={shellFor.name} />
              )}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

type IconBtnProps = React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string; danger?: boolean };

// forwardRef so it can sit under radix `asChild` triggers.
const IconBtn = forwardRef<HTMLButtonElement, IconBtnProps>(function IconBtn({ label, danger, children, className, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      {...rest}
      className={`rounded p-1 text-gray-500 hover:bg-gray-100 disabled:opacity-40 dark:hover:bg-gray-800 [&_svg]:size-3.5 ${danger ? 'hover:text-red-600' : 'hover:text-gray-900 dark:hover:text-gray-100'} ${className || ''}`}
    >
      {children}
    </button>
  );
});
