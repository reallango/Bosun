import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync, execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

// The package runs on the host's /bin/sh: Alpine and most container images are busybox, whose awk, sed, date and grep are
// not GNU. These tests run the changed scripts under busybox sh with every applet (not the GNU tool of the same name) on
// PATH, and a fake docker/git that records what the script asked for.
const scripts = path.join(process.cwd(), 'widgets', 'docker', 'scripts');
const hasBusybox = spawnSync('busybox', ['true'], { stdio: 'ignore' }).status === 0;

let root = '';
let bin = '';
let home = '';

const setup = () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'bosun-busybox-'));
  bin = path.join(root, 'bin');
  home = path.join(root, 'home');
  fs.mkdirSync(bin);
  fs.mkdirSync(home);
  execFileSync('busybox', ['--install', '-s', bin], { stdio: 'ignore' });
};

const stub = (name: string, body: string) => {
  fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
};

/** Run one script the way the host does: busybox sh, busybox tools, the parameters as BOSUN_PARAM_*. */
const run = (script: string, params: Record<string, string> = {}, env: Record<string, string> = {}) => {
  const full: NodeJS.ProcessEnv = { PATH: bin, HOME: home, NODE_ENV: 'test' };
  for (const [k, v] of Object.entries(params)) full[`BOSUN_PARAM_${k}`] = v;
  for (const [k, v] of Object.entries(env)) full[k] = v;
  const r = spawnSync(path.join(bin, 'sh'), [path.join(scripts, script)], { env: full, encoding: 'utf8' });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status };
};

const line = (out: string, key: string): string | undefined => out.split('\n').find(l => l.startsWith(`${key}=`))?.slice(key.length + 1);

describe.skipIf(!hasBusybox)('the Docker scripts on a busybox host (Alpine)', () => {
  beforeEach(setup);
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('summary: a host with no containers reports every number the widget reads', () => {
    stub('docker', `case "$1" in
  ps) case "$*" in *'{{.Image}}'*) exit 0 ;; *-q*) exit 0 ;; *'{{.ID}}|'*) exit 0 ;; esac ;;
  *) exit 0 ;;
esac`);
    const r = run('summary.sh');
    expect(r.stdout).not.toContain('ERROR');
    expect(line(r.stdout, 'docker.available')).toBe('true');
    expect(line(r.stdout, 'docker.total')).toBe('0');
    expect(line(r.stdout, 'docker.running')).toBe('0');
    expect(line(r.stdout, 'docker.stopped')).toBe('0');
    expect(line(r.stdout, 'docker.stacks')).toBe('0');
    expect(line(r.stdout, 'docker.split')).toBe('0 running · 0 stopped');
    expect(line(r.stdout, 'docker.errors')).toBe('0');
    expect(line(r.stdout, 'docker.health_total')).toBe('0');
    expect(line(r.stdout, 'docker.healthy')).toBe('0');
    expect(line(r.stdout, 'docker.updates')).toBe('0');
    expect(line(r.stdout, 'docker.updates_checked')).toBe('0');
    expect(line(r.stdout, 'docker.updates_unknown')).toBe('0');
    // a percentage of nothing is not printed (the widget shows the count instead)
    expect(line(r.stdout, 'docker.running_pct')).toBeUndefined();
    expect(line(r.stdout, 'docker.healthy_pct')).toBeUndefined();
  });

  it('summary: counts running, stopped and unhealthy containers and their uptime', () => {
    stub('docker', `case "$1" in
  ps) case "$*" in
    *'{{.Image}}'*) exit 0 ;;
    *-q*) echo b1 ;;
    *'{{.ID}}|'*) printf 'b1|running|Up 2 hours (healthy)|demo\\nb2|exited|Exited (1) 2 days ago|\\nb3|restarting|Restarting (1) 5 seconds ago|demo\\n' ;;
    *) exit 0 ;;
  esac ;;
  inspect) echo '2020-01-01T00:00:00.123456789Z' ;;
  version) echo 27.3.1 ;;
  *) exit 0 ;;
esac`);
    const r = run('summary.sh');
    expect(line(r.stdout, 'docker.version')).toBe('27.3.1');
    expect(line(r.stdout, 'docker.total')).toBe('3');
    expect(line(r.stdout, 'docker.running')).toBe('1');
    expect(line(r.stdout, 'docker.stopped')).toBe('2');
    expect(line(r.stdout, 'docker.stacks')).toBe('1');
    expect(line(r.stdout, 'docker.errors')).toBe('2');
    expect(line(r.stdout, 'docker.health_total')).toBe('1');
    expect(line(r.stdout, 'docker.healthy')).toBe('1');
    expect(line(r.stdout, 'docker.healthy_pct')).toBe('100');
    expect(line(r.stdout, 'docker.running_pct')).toBe('33');
    expect(line(r.stdout, 'docker.avg_uptime')).toMatch(/^\d+$/);
  });

  it('stacks: an empty host is an empty array, and a stack carries its Git credential', () => {
    stub('docker', `case "$1" in
  ps) case "$*" in
    *'com.docker.compose.project'*) [ -f "${path.join(bin, 'ps.rows')}" ] && cat "${path.join(bin, 'ps.rows')}"; exit 0 ;;
    *) exit 0 ;;
  esac ;;
  *) exit 0 ;;
esac`);
    expect(run('stacks.sh').stdout.trim()).toBe('[]');

    fs.mkdirSync(path.join(home, 'bosun-stacks', 'demo'), { recursive: true });
    fs.writeFileSync(path.join(home, 'bosun-stacks', 'demo', 'bosun.meta'),
      'source=git\nrepo=https://github.com/owner/repo\nbranch=main\nfile=compose.yaml\nupdated=2026-11-01T00:00:00Z\ncredential=mig_git_github_com\n');
    fs.writeFileSync(path.join(bin, 'ps.rows'), 'demo\tweb\trunning\n');
    const rows = JSON.parse(run('stacks.sh').stdout);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'demo', status: 'running', source: 'git', credential: 'mig_git_github_com' });
  });

  it('container_create: a capability Docker grants by default is not elevated, SYS_ADMIN is refused', () => {
    stub('docker', `case "$1" in
  ps) exit 0 ;;
  image) echo 'sha256:${'1'.repeat(64)}' ;;
  create) echo a1b2c3d4e5f6 ;;
  inspect) echo /web ;;
  *) exit 0 ;;
esac`);
    const ok = run('container_create.sh', { settings: 'name=web\nimage=nginx:latest\ncap_add=NET_RAW', allow_risky: 'false' });
    expect(ok.stdout).not.toContain('ERROR');
    expect(ok.stdout).toContain('DONE created web');

    const refused = run('container_create.sh', { settings: 'name=web\nimage=nginx:latest\ncap_add=SYS_ADMIN', allow_risky: 'false' });
    expect(refused.stdout).toContain('ERROR: needs elevated container options (capability SYS_ADMIN)');
  });

  it('git: the credential of an entry is used when its host is spelled with capitals', () => {
    const header = path.join(bin, 'header.txt');
    stub('git', `printf '%s' "$GIT_CONFIG_VALUE_0" > "${header}"
printf 'ref: refs/heads/main\\tHEAD\\naaaa\\tHEAD\\naaaa\\trefs/heads/main\\nbbbb\\trefs/heads/dev\\n'`);
    const creds = { BOSUN_CRED_GIT_HOST: 'GitHub.com', BOSUN_CRED_GIT_TOKEN: 'tok' };
    const r = run('git_branches.sh', { repo: 'https://github.com/owner/repo' }, creds);
    expect(r.stdout).not.toContain('ERROR');
    expect(JSON.parse(r.stdout).items[0]).toEqual({ name: 'main', default: true });
    expect(fs.readFileSync(header, 'utf8')).toBe(`Authorization: Basic ${Buffer.from('x-access-token:tok').toString('base64')}`);

    const other = run('git_branches.sh', { repo: 'https://github.com/owner/repo' }, { BOSUN_CRED_GIT_HOST: 'gitlab.com', BOSUN_CRED_GIT_TOKEN: 'tok' });
    expect(other.stdout).not.toContain('ERROR');
    expect(fs.readFileSync(header, 'utf8')).toBe('');
  });

  it('backup_run: a destination inside the settings blob is refused, not silently ignored', () => {
    stub('docker', `case "$1" in
  ps) case "$*" in *-aq*) exit 0 ;; esac ;;
  inspect) exit 0 ;;
  *) exit 0 ;;
esac`);
    const r = run('backup_run.sh', {
      mode: 'run', kind: 'container', name: 'web', settings: 'destination=abc\nvolumes=true\binds=false\nimage=false',
    }, {
      BOSUN_CRED_BACKUP_DESTINATION_REPOSITORY: path.join(root, 'repo'),
      BOSUN_CRED_BACKUP_DESTINATION_PASSWORD: 'pw',
    });
    expect(r.stdout).toContain("ERROR: unknown backup setting 'destination'");
  });
});
