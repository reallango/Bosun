'use client';

/**
 * The `credentials` block: the entries of one credential kind of a package (a Git token for one owner/repository, a
 * backup destination for one server) with their public fields, server scope, whether each secret is set, the last use
 * and the default marker. Secrets are write-only: the form shows whether one is set and its last four characters, and an
 * edit leaves it unchanged unless a new value is typed.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Dialog } from 'radix-ui';
import { KeyRound, Plus, Trash2, X } from 'lucide-react';
import { buttonClass, DIALOG_CONTENT, DIALOG_FOOTER, DIALOG_HEADER, DIALOG_OVERLAY, DIALOG_TITLE, DIALOG_WIDTH, iconButtonClass, inputClass, primarySubmitClass } from './styles';
import type { LayoutUi } from './LayoutView';
import type { CredentialEntryView, CredentialKindView, CredentialWriteView } from '@/lib/widgets/runtime/credential-view';

type Block = { type: 'credentials'; kind: string; title?: string; description?: string; rowAction?: { action: string; label: string; icon?: string } };

const emptyDraft = (kind: CredentialKindView | null): CredentialWriteView => ({
  name: '', fields: Object.fromEntries((kind?.fields ?? []).filter(f => f.type === 'string').map(f => [f.id, ''])),
  secrets: {}, servers: [], isDefault: false,
});

export function CredentialsBlock({ block, ui }: { block: Block; ui: LayoutUi }) {
  const api = ui.credentials;
  const [kind, setKind] = useState<CredentialKindView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<CredentialWriteView | null>(null);
  const [editing, setEditing] = useState<CredentialEntryView | null>(null);
  const [servers, setServers] = useState<{ id: string; name: string }[]>([]);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    if (!api) { setError('Credentials are not available here.'); setLoading(false); return; }
    const r = await api.load(block.kind);
    setLoading(false);
    if (r.ok) { setKind(r.value); setError(null); } else setError(r.error);
  }, [api, block.kind]);

  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => { if (api) void api.servers().then(setServers).catch(() => undefined); }, [api]);

  const serverName = useMemo(() => new Map(servers.map(s => [s.id, s.name])), [servers]);
  const publicFields = (kind?.fields ?? []).filter(f => f.type === 'string');
  const secretFields = (kind?.fields ?? []).filter(f => f.type === 'secret');

  const startEdit = (entry: CredentialEntryView) => {
    setEditing(entry);
    setDraft({
      id: entry.id, name: entry.name, fields: { ...entry.fields },
      // Left out means unchanged; the form only sends what the admin types.
      secrets: {}, servers: [...entry.servers], isDefault: entry.isDefault,
    });
  };

  const save = async () => {
    if (!api || !draft) return;
    setBusy(true);
    const r = await api.save(block.kind, draft);
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    setDraft(null); setEditing(null); setError(null); void reload();
  };

  const remove = async (entry: CredentialEntryView) => {
    if (!api) return;
    if (!window.confirm(`Delete the credential "${entry.name}"? Scripts that use it stop working until another one matches.`)) return;
    const r = await api.remove(block.kind, entry.id);
    if (!r.ok) setError(r.error); else void reload();
  };

  const runRowAction = (entry: CredentialEntryView) => {
    if (!block.rowAction) return;
    const action = ui.actions.get(block.rowAction.action);
    if (action) ui.onAction(action, { destination: entry.id });
  };

  const title = block.title ?? kind?.label ?? 'Credentials';

  return (
    <div className="space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-1.5 text-sm font-medium"><KeyRound className="size-4" aria-hidden /> {title}</h3>
          {block.description && <p className="text-xs text-muted-foreground">{block.description}</p>}
        </div>
        {kind?.canManage && (
          <button type="button" className={buttonClass} onClick={() => { setEditing(null); setDraft(emptyDraft(kind)); }}>
            <Plus className="size-3" aria-hidden /> Add
          </button>
        )}
      </div>
      {error && <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1 text-xs text-destructive">{error}</div>}
      {loading ? <p className="text-xs text-muted-foreground">Loading…</p> : kind && (
        kind.entries.length === 0
          ? <p className="text-xs text-muted-foreground">No entries yet.</p>
          : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-left text-muted-foreground">
                  <tr>
                    <th className="py-1 pr-2 font-medium">Name</th>
                    {publicFields.map(f => <th key={f.id} className="py-1 pr-2 font-medium">{f.label}</th>)}
                    <th className="py-1 pr-2 font-medium">Servers</th>
                    {secretFields.map(f => <th key={f.id} className="py-1 pr-2 font-medium">{f.label}</th>)}
                    <th className="py-1 pr-2 font-medium">Last used</th>
                    <th className="py-1 pr-2" />
                  </tr>
                </thead>
                <tbody>
                  {kind.entries.map(entry => (
                    <tr key={entry.id} className="border-t border-border/60 align-top">
                      <td className="py-1 pr-2">
                        <span className="font-medium">{entry.name}</span>
                        {entry.isDefault && <span className="ml-1 rounded bg-primary/10 px-1 text-[10px] text-primary">default</span>}
                      </td>
                      {publicFields.map(f => <td key={f.id} className="max-w-[16rem] truncate py-1 pr-2 font-mono" title={entry.fields[f.id] ?? ''}>{entry.fields[f.id] || <span className="text-muted-foreground">—</span>}</td>)}
                      <td className="py-1 pr-2">{entry.servers.length ? entry.servers.map(s => serverName.get(s) ?? s).join(', ') : <span className="text-muted-foreground">All servers</span>}</td>
                      {secretFields.map(f => {
                        const s = entry.secrets[f.id];
                        return <td key={f.id} className="py-1 pr-2">{s?.set ? <span title="A secret is set">{s.hint ? `set …${s.hint}` : 'set'}</span> : <span className="text-muted-foreground">not set</span>}</td>;
                      })}
                      <td className="py-1 pr-2 text-muted-foreground">
                        {entry.lastUsedAt ? `${new Date(entry.lastUsedAt).toLocaleString()}${entry.lastUsedAction ? ` (${entry.lastUsedAction})` : ''}` : '—'}
                      </td>
                      <td className="py-1 pr-2">
                        <div className="flex items-center justify-end gap-1">
                          {block.rowAction && <button type="button" className={buttonClass} onClick={() => runRowAction(entry)}>{block.rowAction.label}</button>}
                          {kind.canManage && <button type="button" className={buttonClass} onClick={() => startEdit(entry)}>Edit</button>}
                          {kind.canManage && <button type="button" className={`${iconButtonClass} text-destructive`} aria-label={`Delete ${entry.name}`} onClick={() => void remove(entry)}><Trash2 className="size-3" aria-hidden /></button>}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
      )}

      <Dialog.Root open={draft !== null} onOpenChange={open => { if (!open) { setDraft(null); setEditing(null); } }}>
        <Dialog.Portal>
          <Dialog.Overlay className={DIALOG_OVERLAY} />
          <Dialog.Content className={`${DIALOG_CONTENT} ${DIALOG_WIDTH}`}>
            <div className={DIALOG_HEADER}>
              <Dialog.Title className={DIALOG_TITLE}>{editing ? `Edit ${editing.name}` : `Add ${kind?.label ?? 'credential'}`}</Dialog.Title>
              <Dialog.Close className={iconButtonClass} aria-label="Close"><X className="size-4" aria-hidden /></Dialog.Close>
            </div>
            {draft && kind && (
              <div className="space-y-2">
                <label className="block space-y-0.5">
                  <span className="text-xs text-muted-foreground">Name</span>
                  <input className={inputClass} value={draft.name} placeholder="A name only you see here" onChange={e => setDraft({ ...draft, name: e.target.value })} />
                </label>
                {kind.fields.map(f => (
                  <label key={f.id} className="block space-y-0.5">
                    <span className="text-xs text-muted-foreground">{f.label}{!f.optional && <span className="text-destructive"> *</span>}</span>
                    {f.type === 'secret' ? (
                      <input className={inputClass} type="password" autoComplete="new-password"
                        placeholder={editing?.secrets[f.id]?.set ? `set${editing.secrets[f.id]?.hint ? ` …${editing.secrets[f.id]?.hint}` : ''} — leave blank to keep it` : 'not set'}
                        onChange={e => setDraft({ ...draft, secrets: { ...draft.secrets, [f.id]: e.target.value } })} />
                    ) : (
                      <input className={inputClass} value={draft.fields[f.id] ?? ''} onChange={e => setDraft({ ...draft, fields: { ...draft.fields, [f.id]: e.target.value } })} />
                    )}
                    {f.help && <span className="block text-[11px] text-muted-foreground">{f.help}</span>}
                  </label>
                ))}
                <div className="space-y-1">
                  <span className="text-xs text-muted-foreground">Servers{kind.servers === 'required' ? <span className="text-destructive"> *</span> : ' (none = every server)'}</span>
                  {servers.length === 0 ? <p className="text-[11px] text-muted-foreground">No servers.</p> : servers.map(s => (
                    <label key={s.id} className="flex items-center gap-2 text-xs">
                      <input type="checkbox" checked={draft.servers.includes(s.id)}
                        onChange={e => setDraft({ ...draft, servers: e.target.checked ? [...draft.servers, s.id] : draft.servers.filter(x => x !== s.id) })} />
                      {s.name}
                    </label>
                  ))}
                </div>
                {kind.defaultPerServer && (
                  <label className="flex items-center gap-2 text-xs">
                    <input type="checkbox" checked={draft.isDefault} onChange={e => setDraft({ ...draft, isDefault: e.target.checked })} />
                    The default destination for these servers
                  </label>
                )}
                {error && <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1 text-xs text-destructive">{error}</div>}
              </div>
            )}
            <div className={DIALOG_FOOTER}>
              <button type="button" className={buttonClass} onClick={() => { setDraft(null); setEditing(null); }}>Cancel</button>
              <button type="button" className={primarySubmitClass} disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
