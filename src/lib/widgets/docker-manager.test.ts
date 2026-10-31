import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { validateManifest } from './package-manifest';
import { reviewPackage } from './runtime/review';
import { editorInitial, serializeEditor } from './runtime/layout';
import { validateParamValues } from './runtime/script-run';
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
    expect(Object.keys(spec.screens ?? {}).sort()).toEqual(['create', 'edit', 'manage', 'stack_edit', 'stack_new']);
    expect(spec.menu?.map(m => m.id)).toEqual(['new_container', 'new_stack', 'manage']);
    expect(Object.keys(spec.datasets ?? {}).sort()).toEqual(['convert', 'export_compose', 'export_run', 'exposed_ports', 'git_branches', 'git_files', 'git_services', 'images', 'inspect', 'networks', 'stack_get', 'stacks', 'system', 'volumes']);
    const review = reviewPackage(manifest);
    expect(review.runsAsService).toBe(true);
    expect(review.widgets[0].commands.some(c => /dataset "inspect"/.test(c.what))).toBe(true);
  });

  it('keeps risky things behind their own permissions', () => {
    const perms = (id: string) => spec.actions.find(a => a.id === id)!.permission;
    for (const id of ['create_privileged', 'recreate_privileged', 'stack_deploy_privileged']) expect(perms(id), id).toBe('docker.privileged');
    for (const id of ['create', 'recreate', 'stack_deploy', 'image_pull', 'volume_create', 'network_create']) expect(perms(id), id).toBe('docker.manage');
    for (const id of ['remove', 'image_remove', 'image_prune', 'volume_remove', 'volume_prune', 'network_remove', 'network_prune', 'stack_remove']) expect(perms(id), id).toBe('docker.delete');
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
    for (const id of ['remove', 'image_remove', 'image_prune', 'volume_remove', 'volume_prune', 'network_remove', 'network_prune', 'stack_remove', 'recreate', 'recreate_privileged', 'stack_deploy_privileged']) {
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
    expect(() => validateParamValues(params, { name: 'demo', source: 'editor', yaml: String(values.yaml), env: '', repo: '-', branch: '-', file: '-', pull: 'false', allow_risky: 'false', override: '' })).not.toThrow();
    expect(() => validateParamValues(params, { name: 'demo', source: 'git', yaml: '', env: 'A=1', repo: 'https://github.com/owner/repo', branch: 'main', file: 'deploy/compose.yaml', pull: 'true', allow_risky: 'false', override: 'svc.web.port=8080:80/tcp\nsvc.web.container_name=site' })).not.toThrow();
    expect(() => validateParamValues(params, { name: 'demo', source: 'git', yaml: '', env: '', repo: 'http://github.com/owner/repo', branch: 'main', file: 'a', pull: 'false', allow_risky: 'false', override: '' })).toThrow();   // https only
    expect(() => validateParamValues(params, { name: 'Bad Name', source: 'editor', yaml: '', env: '', repo: '-', branch: '-', file: '-', pull: 'false', allow_risky: 'false', override: '' })).toThrow();
    expect(() => validateParamValues(params, { name: 'demo', source: 'git', yaml: '', env: '', repo: 'https://github.com/owner/repo', branch: 'main', file: 'a.yml', pull: 'false', allow_risky: 'false', override: 'svc.web.volume=/etc:/etc\nrm -rf /' })).toThrow();   // an override line must be a svc.<service>.<setting>=value line
    // only the stack and git scripts receive the GitHub token
    const withToken = ['stack_deploy', 'stack_action', 'git_branches', 'git_files', 'git_services'];
    for (const [id, s] of Object.entries(spec.scripts!)) expect(Boolean(s.secrets?.length), id).toBe(withToken.includes(id));
  });
});
