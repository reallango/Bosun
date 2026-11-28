import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { validateManifest } from './package-manifest';
import { reviewPackage } from './runtime/review';
import { editorInitial, serializeEditor } from './runtime/layout';
import { validateParamValues } from './runtime/script-run';
import { elevatedHint, elevatedSiblingOf, explainElevated } from './runtime/elevated';
import type { Block, EditorField } from './runtime/spec-v2';

// The Docker manager is a package like any other: its screens, datasets and actions are checked here against each other and
// against the scripts it ships, so a change to one cannot silently break another.
const dir = path.join(process.cwd(), 'widgets', 'docker');
const raw = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
const parsed = validateManifest(raw);
if (!parsed.ok) throw new Error(parsed.error);
const manifest = parsed.value;
const spec = manifest.widgets[0].spec!;
const script = (name: string) => fs.readFileSync(path.join(dir, 'scripts', `${name}.sh`), 'utf8');

const editors = (blocks: Block[]): Extract<Block, { type: 'editor' }>[] => blocks.flatMap(b =>
  b.type === 'editor' ? [b] : b.type === 'tabs' ? b.tabs.flatMap(t => editors(t.blocks)) : b.type === 'section' ? editors(b.blocks) : []);

/** The keys of the settings blob (docs/plans/docker-manager.md). */
const BLOB_KEYS = ['name', 'image', 'cmd', 'entrypoint', 'env', 'port', 'volume', 'tmpfs', 'label', 'network', 'network_alias', 'restart', 'hostname', 'user', 'workdir', 'memory', 'cpus',
  'dns', 'add_host', 'log_driver', 'log_opt', 'stop_signal', 'stop_timeout', 'tty', 'interactive', 'init', 'read_only', 'health_cmd', 'health_interval', 'health_timeout', 'health_retries',
  'privileged', 'pid', 'ipc', 'cap_add', 'cap_drop', 'device', 'security_opt', 'sysctl', 'gpus'];
const RISKY_KEYS = ['privileged', 'pid', 'ipc', 'cap_add', 'device', 'security_opt', 'sysctl'];

describe('the Docker manager package', () => {
  it('has screens, datasets and menu entries that exist, and a review that lists what runs', () => {
    expect(Object.keys(spec.screens ?? {}).sort()).toEqual(['backup_target', 'create', 'edit', 'manage', 'restore_backup', 'stack_edit', 'stack_new']);
    expect(spec.menu?.map(m => m.id)).toEqual(['new_container', 'new_stack', 'manage']);
    expect(Object.keys(spec.datasets ?? {}).sort()).toEqual(['backups', 'convert', 'export_compose', 'export_run', 'exposed_ports', 'git_branches', 'git_files', 'git_services', 'host_detect', 'image_updates', 'image_updates_summary', 'images', 'inspect', 'networks', 'stack_get', 'stacks', 'system', 'volumes']);
    const review = reviewPackage(manifest);
    expect(review.runsAsService).toBe(true);
    expect(review.widgets[0].commands.some(c => /dataset "inspect"/.test(c.what))).toBe(true);
  });

  it('points a plain action that refuses elevated options at the action that allows them', () => {
    const action = (id: string) => spec.actions.find(a => a.id === id)!;
    const sibling = (id: string) => elevatedSiblingOf(action(id), spec.actions)?.id ?? null;
    for (const [plain, elevated] of [
      ['stack_deploy', 'stack_deploy_privileged'], ['stack_deploy_later', 'stack_deploy_privileged_later'],
      ['create', 'create_privileged'], ['recreate', 'recreate_privileged'], ['stack_update', 'stack_update_privileged'],
    ]) expect(sibling(plain), plain).toBe(elevated);
    expect(sibling('container_update')).toBeNull();
    expect(sibling('stack_deploy_privileged')).toBeNull();
    const label = (id: string) => manifest.permissions.find(p => p.id === id)?.label ?? id;
    expect(explainElevated(
      'needs elevated container options (capability SYS_ADMIN, security option seccomp=unconfined)', action('stack_deploy'), spec.actions, label,
    )).toBe('needs elevated container options (capability SYS_ADMIN, security option seccomp=unconfined): use "Deploy with elevated options" (stack_deploy_privileged), which needs the "Use elevated container options" permission');
    expect(explainElevated('the script failed', action('stack_deploy'), spec.actions, label)).toBe('the script failed');
    expect(elevatedHint(action('stack_deploy'), spec.actions, label)).toBe(' Options that need elevation use the "Deploy with elevated options" action (stack_deploy_privileged), which needs the "Use elevated container options" permission.');
    expect(elevatedHint(action('container_update'), spec.actions, label)).toBe('');
  });

  it('the Manage page counts its tabs and keeps the create forms behind buttons', () => {
    const manage = spec.screens!.manage;
    const tabs = manage.blocks.find(b => b.type === 'tabs') as Extract<Block, { type: 'tabs' }>;
    const tab = (id: string) => tabs.tabs.find(t => t.id === id)!;
    expect(tab('containers').count).toBe('data');
    for (const id of ['images', 'volumes', 'networks', 'stacks']) expect(tab(id).count, id).toBe(`datasets.${id}`);
    expect(tab('images').blocks[0]).toMatchObject({ type: 'form', open: 'dialog', label: 'Pull image' });
    expect(tab('volumes').blocks[0]).toMatchObject({ type: 'editor', open: 'dialog', label: 'New volume' });
    expect(tab('networks').blocks[0]).toMatchObject({ type: 'editor', open: 'dialog', label: 'New network' });
    expect(manifest.requires).toEqual({ api: 12 }); // level 12: credential kinds on a package screen
  });

  it('has a Backups tab over the backups dataset, with the destination state and the pinned image', () => {
    const manage = spec.screens!.manage;
    const tabs = manage.blocks.find(b => b.type === 'tabs') as Extract<Block, { type: 'tabs' }>;
    const tab = tabs.tabs.find(t => t.id === 'backups')!;
    expect(tab.count).toBe('datasets.backups.rows');
    expect(manage.load['backups']).toEqual({ dataset: 'backups', args: {} });
    expect(spec.datasets!.backups).toMatchObject({ script: 'backup_restore', permission: 'docker.backup', resources: { container: 'container', stack: 'stack' } });
    const view = tab.blocks.find(b => b.type === 'view') as Extract<Block, { type: 'view' }>;
    expect(view.path).toBe('datasets.backups.rows');
    expect((view.view as { columns?: { title: string }[] }).columns?.map(c => c.title)).toEqual(['Target', 'Destination', 'Kind', 'Time', 'Size', 'Added', 'Included', 'Pinned image', 'Snapshot']);
    expect(view.view.open).toBe('restore_backup');
    const facts = tab.blocks.find(b => b.type === 'kv') as Extract<Block, { type: 'kv' }>;
    expect(facts.items.map(i => i.label)).toEqual(['Destination', 'Repository', 'State', 'Snapshots', 'Repository on disk']);
    // The backup dialog sits on the container and stack tabs, with the inclusion and retention options.
    for (const [id, label] of [['containers', 'Back up a container'], ['stacks', 'Back up a stack']] as const) {
      const blocks = tabs.tabs.find(t => t.id === id)!.blocks;
      const editor = blocks.find(b => b.type === 'editor' && b.open === 'dialog' && b.label === label) as Extract<Block, { type: 'editor' }>;
      expect(editor.param, id).toBe('settings');
      expect(editor.submits[0].action, id).toBe('backup_run');
      expect(editor.fields.some(f => f.name === 'keep_daily'), id).toBe(true);
    }
    expect(spec.actions.find(a => a.id === 'backup_run')).toMatchObject({ kind: 'script', permission: 'docker.backup', job: true });
    expect(spec.actions.find(a => a.id === 'backup_restore')).toMatchObject({ kind: 'script', permission: 'docker.restore', job: true });
  });

  it('offers the image update check and the new backup and update schedules', () => {
    expect(spec.schedules?.map(s => s.id)).toEqual([
      'image_updates', 'backup', 'image_update_container', 'image_update_stack', 'image_update_container_backup', 'image_update_stack_backup',
    ]);
    expect(spec.schedules?.find(s => s.id === 'image_updates')).toMatchObject({
      run: { dataset: 'image_updates' }, target: 'server',
      notify: expect.objectContaining({ when: { field: 'update_available', equals: true } }),
    });
    expect(spec.schedules?.find(s => s.id === 'backup')).toMatchObject({
      run: { action: 'backup_run' }, target: 'byKind',
      notify: expect.objectContaining({ title: expect.stringContaining('Scheduled backup') }),
    });
    for (const id of ['image_update_container', 'image_update_stack', 'image_update_container_backup', 'image_update_stack_backup']) {
      expect(spec.schedules?.find(s => s.id === id)?.notify, id).toBeDefined();
    }
    expect(spec.datasets?.image_updates).toBeDefined();
  });

  it('gives the backup actions a per-kind target and the update actions a backup-first variant', () => {
    expect(spec.actions.find(a => a.id === 'backup_run')?.target).toEqual({ byKind: 'kind', param: 'name' });
    expect(spec.actions.find(a => a.id === 'backup_restore')?.target).toEqual({ byKind: 'kind', param: 'name' });
    expect(spec.actions.find(a => a.id === 'backup_dialog')).toMatchObject({ kind: 'screen', screen: 'backup_target', permission: 'docker.backup' });
    expect(spec.actions.find(a => a.id === 'backup_init')).toMatchObject({ kind: 'script', permission: 'docker.backup', job: true });
    for (const id of ['container_update_backup', 'stack_update_images_backup']) {
      const a = spec.actions.find(x => x.id === id)!;
      expect(a.permission, id).toBe('docker.backup_update');
      expect(a.variants?.[0].before, id).toMatchObject({ script: 'backup_run' });
    }
    const perm = manifest.permissions.find(p => p.id === 'docker.backup_update');
    expect(perm?.implies.sort()).toEqual(['docker.backup', 'docker.manage']);
  });

  it('opens the backup dialog prefilled with the row and keeps the quick backup in the menus', () => {
    const screen = spec.screens!.backup_target;
    const editor = screen.blocks.find(b => b.type === 'editor') as Extract<Block, { type: 'editor' }>;
    expect(editor.param).toBe('settings');
    expect(editor.submits[0]).toMatchObject({ action: 'backup_run', params: { kind: 'values.kind', name: 'values.name' } });
    expect(editor.fields.find(f => f.name === 'kind')).toMatchObject({ value: 'context.kind', transient: true });
    expect(editor.fields.find(f => f.name === 'name')).toMatchObject({ value: 'context.name', transient: true });
    expect(editor.fields.find(f => f.name === 'stack_files')?.when).toEqual({ field: 'values.kind', equals: 'stack' });
    expect(editor.fields.find(f => f.name === 'keep_daily')).toBeDefined();

    const list = (spec.view as unknown as { blocks: Array<{ type: string; view?: { row?: { actions?: string[] } } }> })
      .blocks.find(b => b.type === 'view')!.view!;
    expect(list.row?.actions).toContain('backup_run');
    expect(list.row?.actions).toContain('backup_dialog');
    const manage = spec.screens!.manage;
    const tabs = manage.blocks.find(b => b.type === 'tabs') as Extract<Block, { type: 'tabs' }>;
    for (const id of ['containers', 'stacks']) {
      const view = (tabs.tabs.find(t => t.id === id)!.blocks.find(b => b.type === 'view') as Extract<Block, { type: 'view' }>).view;
      expect(view.rowActions, id).toContain('backup_run');
      expect(view.rowActions, id).toContain('backup_dialog');
    }
  });

  it('the Manage page offers bulk actions on its lists and stat tiles on Overview', () => {
    const manage = spec.screens!.manage;
    const tabs = manage.blocks.find(b => b.type === 'tabs') as Extract<Block, { type: 'tabs' }>;
    const tab = (id: string) => tabs.tabs.find(t => t.id === id)!;
    const view = (id: string) => (tab(id).blocks.find(b => b.type === 'view') as Extract<Block, { type: 'view' }>).view;
    expect(view('images').bulk).toEqual(['image_remove']);
    expect(view('containers').bulk).toEqual(['stop', 'start', 'remove']);
    expect(view('volumes').bulk).toEqual(['volume_remove']);
    expect(view('stacks').bulk).toEqual(['stack_remove']);
    expect(view('networks').bulk).toBeUndefined();

    const overview = tab('overview').blocks;
    const stat = overview.find(b => b.type === 'stat') as Extract<Block, { type: 'stat' }>;
    expect(stat.items.map(i => i.label)).toEqual(['Running', 'Stopped', 'Updates available', 'Images', 'Volumes', 'Build cache']);
    expect(stat.items.find(i => i.label === 'Stopped')).toMatchObject({ tab: 'containers', tone: { warning: { field: 'datasets.system.containers.stopped', gt: 0 } } });
    expect(stat.items.find(i => i.label === 'Updates available')).toMatchObject({ tab: 'containers', value: '{datasets.updates_summary.available}', tone: { warning: { field: 'datasets.updates_summary.available', gt: 0 } } });
    expect(stat.items.find(i => i.label === 'Images')).toMatchObject({ tab: 'images', sub: '{datasets.system.disk.images}' });
    expect(stat.items.find(i => i.label === 'Build cache')).toMatchObject({ tab: 'images', value: '{datasets.system.disk.cache}' });
    // a join is not part of the view spec, so the Containers tab has a small table over the image_updates dataset
    const section = tab('containers').blocks.find(b => b.type === 'section') as Extract<Block, { type: 'section' }>;
    expect(section.title).toBe('Image updates');
    const updates = section.blocks.find(b => b.type === 'view') as Extract<Block, { type: 'view' }>;
    expect(updates.path).toBe('datasets.updates');
    expect((updates.view as { columns?: { title: string }[] }).columns?.map(c => c.title)).toEqual(['Container', 'Image', 'Update', 'Note']);
    const facts = overview.find(b => b.type === 'kv') as Extract<Block, { type: 'kv' }>;
    expect(facts.items.map(i => i.label)).toEqual(['Docker version', 'Compose', 'Compose', 'Volume drivers', 'Network drivers', 'Disk used by containers']);
  });

  it('keeps risky things behind their own permissions', () => {
    const perms = (id: string) => spec.actions.find(a => a.id === id)!.permission;
    for (const id of ['create_privileged', 'recreate_privileged', 'stack_deploy_privileged']) expect(perms(id), id).toBe('docker.privileged');
    for (const id of ['create', 'recreate', 'stack_deploy', 'image_pull', 'volume_create', 'network_create']) expect(perms(id), id).toBe('docker.manage');
    for (const id of ['remove', 'image_remove', 'image_prune', 'volume_remove', 'volume_prune', 'network_remove', 'network_prune', 'stack_remove']) expect(perms(id), id).toBe('docker.delete');
    // backups and restores are their own high-risk permissions
    expect(perms('backup_run')).toBe('docker.backup');
    expect(perms('backup_restore')).toBe('docker.restore');
    // the plain actions never pass allow_risky, the privileged ones always do
    const lit = (id: string) => spec.actions.find(a => a.id === id)!.variants?.length;
    expect(lit('create')).toBe(1);
    expect(raw.widgets[0].spec.actions.find((a: { id: string }) => a.id === 'create').variants[0].args.allow_risky).toBe('literal:false');
    expect(raw.widgets[0].spec.actions.find((a: { id: string }) => a.id === 'create_privileged').variants[0].args.allow_risky).toBe('literal:true');
    expect(raw.widgets[0].spec.actions.find((a: { id: string }) => a.id === 'stack_deploy').variants[0].args.allow_risky).toBe('literal:false');
    expect(raw.widgets[0].spec.actions.find((a: { id: string }) => a.id === 'stack_deploy_privileged').variants[0].args.allow_risky).toBe('literal:true');
    // the dataset that shows a container's environment needs the manage permission
    expect(spec.datasets!.inspect.permission).toBe('docker.manage');
    expect(spec.datasets!.stack_get.permission).toBe('docker.manage');
  });

  it('asks for confirmation before anything is removed or replaced', () => {
    for (const id of ['remove', 'image_remove', 'image_prune', 'volume_remove', 'volume_prune', 'network_remove', 'network_prune', 'stack_remove', 'recreate', 'recreate_privileged', 'stack_deploy_privileged', 'backup_restore']) {
      expect(spec.actions.find(a => a.id === id)!.confirm, id).toBeTruthy();
    }
    for (const id of ['remove', 'volume_remove', 'stack_remove']) expect(spec.actions.find(a => a.id === id)!.confirm!.requireText, id).toBeTruthy();
  });

  it('the editors use only keys of the settings blob, and mark the risky ones', () => {
    for (const screenId of ['edit', 'create']) {
      const [ed] = editors(spec.screens![screenId].blocks);
      const fields = ed.fields.filter(f => f.input !== 'heading' && f.input !== 'button' && !f.transient);
      for (const f of fields) expect(BLOB_KEYS, `${screenId}.${f.name}`).toContain(f.key ?? f.name);
      for (const k of RISKY_KEYS) expect(fields.find(f => (f.key ?? f.name) === k)?.warn, `${screenId}.${k} warns`).toBeTruthy();
      expect(fields.find(f => f.name === 'cap_drop')?.warn).toBeUndefined();
    }
  });

  it('every key of the blob the editors can send is understood by the create and recreate scripts', () => {
    const [ed] = editors(spec.screens!.create.blocks);
    for (const f of ed.fields.filter((x: EditorField) => x.input !== 'heading' && x.input !== 'button' && !x.transient)) {
      const key = f.key ?? f.name;
      for (const s of ['container_create', 'container_recreate']) expect(script(s), `${s} knows "${key}"`).toMatch(new RegExp(`\\b${key}\\)|['"]${key}['"]|\\b${key}\\b`));
    }
  });

  it('stack_retag accepts exactly the four parameters that Bosun self-update sends', () => {
    // src/lib/update/rollout.ts retag() calls stack_retag with only { name, service, image, as }. A node whose build
    // predates parameter defaults sends exactly those four, so any other declared parameter (required or optional)
    // would make the self-update fail with "Missing parameter: <name>" before the script runs.
    const params = spec.actions.find(a => a.id === 'stack_retag')!.params!;
    expect(Object.keys(params).sort()).toEqual(['as', 'image', 'name', 'service']);
    for (const p of Object.values(params)) expect(p).not.toHaveProperty('default');
  });

  it('what an editor sends is accepted by the script parameters', () => {
    const [ed] = editors(spec.screens!.edit.blocks);
    const ctx = { context: { name: 'web' }, datasets: { networks: [{ name: 'bridge' }], cur: { settings: { name: 'web', image: 'nginx:1', restart: 'always', env: ['A=1'], port: ['8080:80/tcp'], volume: ['/srv/a:/a:ro'], tty: 'true' } } } };
    const values = editorInitial(ed.fields, ctx);
    const blob = serializeEditor(ed.fields, values);
    expect(blob).toContain('image=nginx:1');
    expect(blob).toContain('port=8080:80/tcp');
    expect(blob).toContain('tty=true');
    expect(blob).not.toContain('privileged=true');
    const params = spec.scripts!.container_recreate.params;
    expect(() => validateParamValues(params, { name: 'web', settings: blob, allow_risky: 'false' })).not.toThrow();
    expect(() => validateParamValues(params, { name: 'web', settings: blob + '\nnot a key value line', allow_risky: 'false' })).toThrow();
  });

  it('a stack from the editor or from GitHub is deployed with the parameters its script declares', () => {
    const [ed] = editors(spec.screens!.stack_new.blocks);
    const values = editorInitial(ed.fields, { context: undefined });
    values.name = 'demo'; values.yaml = 'services:\n  web:\n    image: nginx\n';
    const params = spec.scripts!.stack_deploy.params;
    expect(() => validateParamValues(params, { name: 'demo', source: 'editor', yaml: String(values.yaml), env: '', repo: '-', branch: '-', file: '-', pull: 'false', allow_risky: 'false', override: '', start: 'now', credential: 'auto' })).not.toThrow();
    expect(() => validateParamValues(params, { name: 'demo', source: 'git', yaml: '', env: 'A=1', repo: 'https://github.com/owner/repo', branch: 'main', file: 'deploy/compose.yaml', pull: 'true', allow_risky: 'false', override: 'svc.web.port=8080:80/tcp\nsvc.web.container_name=site', start: 'later', credential: 'auto' })).not.toThrow();
    expect(() => validateParamValues(params, { name: 'demo', source: 'git', yaml: '', env: '', repo: 'http://github.com/owner/repo', branch: 'main', file: 'a', pull: 'false', allow_risky: 'false', override: '', credential: 'auto' })).toThrow();   // https only
    expect(() => validateParamValues(params, { name: 'Bad Name', source: 'editor', yaml: '', env: '', repo: '-', branch: '-', file: '-', pull: 'false', allow_risky: 'false', override: '', credential: 'auto' })).toThrow();
    expect(() => validateParamValues(params, { name: 'demo', source: 'git', yaml: '', env: '', repo: 'https://github.com/owner/repo', branch: 'main', file: 'a.yml', pull: 'false', allow_risky: 'false', override: 'svc.web.volume=/etc:/etc\nrm -rf /', credential: 'auto' })).toThrow();   // an override line must be a svc.<service>.<setting>=value line
    // no script reads a package secret any more: the Git token and the backup destination are credential entries
    for (const [id, s] of Object.entries(spec.scripts!)) expect(s.secrets, id).toBeUndefined();
    // Only the scripts that really reach git get the Git credential: a deployment (stack_deploy) and an update from
    // source (stack_action with op update). Every other Docker action runs without it, so an older node never has to
    // supply a repo or credential it does not use.
    const gitScripts = ['stack_deploy', 'git_branches', 'git_files', 'git_services'];
    const actions = (Array.isArray(spec.actions) ? spec.actions : Object.values(spec.actions ?? {})) as { id: string; params?: Record<string, unknown>; variants?: { script: string; args?: Record<string, string>; credentials?: unknown }[] }[];
    expect(actions.length).toBeGreaterThan(0);
    for (const a of actions) {
      for (const v of a.variants ?? []) {
        const usesGit = gitScripts.includes(v.script) || (v.script === 'stack_action' && v.args?.op === 'literal:update');
        if (!usesGit) continue;
        expect(v.credentials, a.id).toEqual([{ kind: 'git', entry: 'credential', url: 'repo' }]);
      }
    }
    // The actions that never reach git do not take its parameters or credential either (self-update retags with four
    // parameters only, and an older node would otherwise refuse the call before the script runs).
    for (const id of ['container_update', 'container_update_backup', 'stack_start', 'stack_stop', 'stack_restart', 'stack_guard_up', 'stack_update_images', 'stack_update_images_backup', 'stack_retag']) {
      const action = actions.find(a => a.id === id)!;
      expect(Object.keys(action.params ?? {}), id).not.toContain('repo');
      expect(Object.keys(action.params ?? {}), id).not.toContain('credential');
      for (const v of action.variants ?? []) expect(v.credentials, id).toBeUndefined();
    }
    expect(spec.datasets!.backups!.credentials).toMatchObject([{ kind: 'backup_destination', entry: 'destination', default: true }]);
  });
});
