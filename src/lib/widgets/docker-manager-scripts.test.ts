import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { buildScriptInvocation, parseScriptOutput } from './runtime/script-run';

// The Docker manager's host scripts (widgets/docker/scripts) against a fake `docker` (and `git`) placed first on the PATH. Every
// call of the fake is logged with its exact arguments, so what reaches Docker can be compared argument by argument. A real POSIX
// shell is needed (Linux, as in the Docker build; set BOSUN_TEST_SH=1 to run them in Git Bash on Windows). The scripts are also
// checked against a real Docker daemon by hand (see the integration notes of the change), not here.
const hasSh = (process.platform !== 'win32' || !!process.env.BOSUN_TEST_SH) && spawnSync('sh', ['-c', 'exit 0']).status === 0;
const dir = path.join(process.cwd(), 'widgets', 'docker', 'scripts');
const script = (name: string) => fs.readFileSync(path.join(dir, name), 'utf8');

let bin = '';
let log = '';
let home = '';
beforeEach(() => {
  bin = fs.mkdtempSync(path.join(os.tmpdir(), 'bosun-fakedm-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'bosun-fakehome-'));
  log = path.join(bin, 'calls.log');
  fs.writeFileSync(log, '');
});
afterEach(() => { fs.rmSync(bin, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); });

/** A fake command: the availability probe (`docker ps` alone) answers silently, every other call is logged, then `body` answers. */
const fakeCmd = (cmd: string, body: string) => fs.writeFileSync(path.join(bin, cmd), `#!/bin/sh
${cmd === 'docker' ? '[ "$1" = ps ] && [ $# -eq 1 ] && exit 0' : ''}
{ echo "CALL ${cmd}"; for a in "$@"; do printf 'ARG %s\\n' "$a"; done; } >> "$LOG"
${body}
`, { mode: 0o755 });
const fake = (body: string) => fakeCmd('docker', body);
/** Docker is not installed / not reachable: even the availability probe fails. */
const noDocker = () => fs.writeFileSync(path.join(bin, 'docker'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
/** A path as the shell sees it (on Windows, Git Bash maps C:\\Users\\...\\Temp to /tmp); identity on Linux. */
const sp = (p: string) => (process.platform === 'win32' ? spawnSync('cygpath', ['-u', p], { encoding: 'utf8' }).stdout.trim() : p);
const calls = (): string[][] => {
  const out: string[][] = [];
  for (const line of fs.readFileSync(log, 'utf8').split('\n')) {
    if (line.startsWith('CALL ')) out.push([line.slice(5)]);
    else if (line.startsWith('ARG ') && out.length) out[out.length - 1].push(line.slice(4));
  }
  return out;
};
const dockerCalls = () => calls().filter((c) => c[0] === 'docker').map((c) => c.slice(1));
const verbs = () => dockerCalls().map((c) => c.slice(0, 2).join(' '));

const run = (file: string, params: Record<string, string> = {}, extraEnv: Record<string, string> = {}) => {
  // like the runtime: the text parameters travel on stdin with the script, the rest on the command line
  const inv = buildScriptInvocation('linux', script(file), params, { stdinParams: ['settings', 'input', 'yaml', 'env', 'override'] });
  return spawnSync('sh', ['-c', inv.command], {
    input: inv.stdin, encoding: 'utf8', cwd: bin,
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, LOG: log, HOME: home, BOSUN_RECREATE_WAIT: '0', ...extraEnv },
  });
};
const out = (file: string, params: Record<string, string> = {}, extraEnv: Record<string, string> = {}) => parseScriptOutput(run(file, params, extraEnv).stdout);
const ID = 'a'.repeat(64);
const NEW = 'b'.repeat(64);

describe('settings parser (container_create)', () => {
  const create = (settings: string, allow = 'false') => out('container_create.sh', { settings, allow_risky: allow });
  const ok = `name=web\nimage=nginx:alpine\n`;
  beforeEach(() => fake(`case "$1" in create) echo ${ID} ;; inspect) echo /web ;; esac`));

  it.skipIf(!hasSh)('is the very same text in create and recreate', () => {
    const block = (f: string) => /# >>> settings parser[\s\S]*# <<< settings parser/.exec(script(f))![0];
    expect(block('container_create.sh')).toBe(block('container_recreate.sh'));
    expect(block('container_create.sh').length).toBeGreaterThan(3000);
  });

  it.skipIf(!hasSh)('turns every key into exactly one docker argument, in order, and never into shell text', () => {
    const evil = '$(touch pwned); a `touch pwned2` "q" \'s\' \\ ;|&';
    const r = create([
      '# a comment', '', '   ', 'name=web', 'image=nginx:alpine',
      `env=A=${evil}`, 'env=B=', 'env=C=x=y',
      'port=127.0.0.1::80', 'port=8080:80/tcp', 'port=53:53/udp', 'port=[::1]:9000:90', 'port=3000-3002:3000-3002', 'port=81',
      'volume=data:/data', 'volume=/srv/app:/app:ro', 'tmpfs=/run', 'tmpfs=/tmp:size=10m',
      `label=a.b/c=${evil}`, 'network=mynet', 'network_alias=web1', 'network_alias=web2',
      'restart=on-failure:3', 'hostname=h1', 'user=1000:1000', 'workdir=/srv', 'memory=512', 'cpus=1.5',
      'dns=1.1.1.1', 'dns=9.9.9.9', 'add_host=db:10.0.0.2', 'log_driver=json-file', 'log_opt=max-size=1m', 'log_opt=max-file=3',
      'stop_signal=SIGINT', 'stop_timeout=20', 'tty=true', 'interactive=true', 'init=true', 'read_only=true',
      'health_cmd=curl -f http://localhost/ || exit 1', 'health_interval=30s', 'health_timeout=5s', 'health_retries=3',
      'cap_drop=NET_RAW', 'gpus=all',
      'entrypoint=/bin/sh', 'entrypoint=-c', `cmd=echo ${evil}`, 'cmd=--flag',
    ].join('\n'));
    expect(r.error).toBeNull();
    expect(r.done).toBe('created web');
    const [call] = dockerCalls().filter((c) => c[0] === 'create');
    expect(call).toEqual([
      'create',
      `--env=A=${evil}`, '--env=B=', '--env=C=x=y',
      '--publish=127.0.0.1::80', '--publish=8080:80/tcp', '--publish=53:53/udp', '--publish=[::1]:9000:90', '--publish=3000-3002:3000-3002', '--publish=81',
      '--volume=data:/data', '--volume=/srv/app:/app:ro', '--tmpfs=/run', '--tmpfs=/tmp:size=10m',
      `--label=a.b/c=${evil}`, '--network=mynet', '--network-alias=web1', '--network-alias=web2',
      '--hostname=h1', '--user=1000:1000', '--workdir=/srv', '--memory=512m', '--cpus=1.5',
      '--dns=1.1.1.1', '--dns=9.9.9.9', '--add-host=db:10.0.0.2', '--log-driver=json-file', '--log-opt=max-size=1m', '--log-opt=max-file=3',
      '--stop-signal=SIGINT', '--stop-timeout=20', '--tty', '--interactive', '--init', '--read-only',
      '--health-cmd=curl -f http://localhost/ || exit 1', '--health-interval=30s', '--health-timeout=5s', '--health-retries=3',
      '--cap-drop=NET_RAW', '--gpus=all', '--entrypoint=/bin/sh', '--name=web', '--restart=on-failure:3',
      'nginx:alpine', '-c', `echo ${evil}`, '--flag',
    ]);
    expect(fs.existsSync(path.join(bin, 'pwned'))).toBe(false);
    expect(fs.existsSync(path.join(bin, 'pwned2'))).toBe(false);
    expect(verbs()).toContain('start ' + ID);
  });

  it.skipIf(!hasSh)('treats unset checkboxes (explicit false), empty values, CRLF lines and comments as "not set"', () => {
    const r = create(['name=w', 'image=nginx', 'tty=false', 'interactive=false', 'init=false', 'read_only=false', 'privileged=false', 'pid=', 'ipc=', 'memory=', 'cpus=', 'user=', 'network=', 'restart=', 'cmd=', 'env=', '# x'].join('\r\n'));
    expect(r.error).toBeNull();
    expect(dockerCalls().find((c) => c[0] === 'create')).toEqual(['create', '--name=w', 'nginx']);
  });

  it.skipIf(!hasSh)('memory units and the clear-entrypoint form', () => {
    create(`${ok}memory=2g\nentrypoint=`);
    expect(dockerCalls().find((c) => c[0] === 'create')).toEqual(['create', '--memory=2g', '--entrypoint=', '--name=web', 'nginx:alpine']);
  });

  it.skipIf(!hasSh)('refuses what is not valid, naming the line or key, and never reaches docker', () => {
    const cases: [string, RegExp][] = [
      ['image=nginx\nbogus=1', /unknown setting 'bogus'/],
      ['image=nginx\nname=a\nname=b', /name is given twice/],
      ['image=nginx\nno equals sign', /line 2 has no '='/],
      ['image=nginx\nname=-bad', /^name:/],
      ['image=nginx\nname=a b', /^name:/],
      ['image=nginx\nname=a/b', /^name:/],
      ['image=nginx\nname=' + 'a'.repeat(129), /^name:/],
      ['image=-nginx', /^image:/],
      ['image=ng inx', /^image:/],
      ['image=nginx;rm', /^image:/],
      ['image=nginx$(x)', /^image:/],
      ['name=x', /image is required/],
      ['image=n\nenv=NOEQUALS', /^env:/],
      ['image=n\nenv=1A=b', /^env: invalid variable name/],
      ['image=n\nenv=A B=c', /^env: invalid variable name/],
      ['image=n\nport=abc', /^port:/], ['image=n\nport=80:80:80:80', /^port:/], ['image=n\nport=1.2.3.4.5:80:80', /^port:/],
      ['image=n\nport=80/xyz', /^port:/], ['image=n\nport=a:80', /^port:/], ['image=n\nport=[zz]:1:2', /^port:/],
      ['image=n\nvolume=nocolon', /^volume:/], ['image=n\nvolume=a:b', /^volume: the target/], ['image=n\nvolume=a:/b:zz', /^volume: the mode/],
      ['image=n\nvolume=rel/path:/b', /^volume: the source/], ['image=n\nvolume=-x:/b', /^volume: the source/],
      ['image=n\ntmpfs=rel', /^tmpfs:/], ['image=n\ntmpfs=/a:b c', /^tmpfs:/],
      ['image=n\nlabel=novalue', /^label:/], ['image=n\nlabel=bad key=v', /^label: invalid key/],
      ['image=n\nnetwork=bad name', /^network:/], ['image=n\nnetwork=a/b', /^network:/],
      ['image=n\nrestart=sometimes', /^restart:/], ['image=n\nrestart=on-failure:x', /^restart:/],
      ['image=n\nmemory=12x', /^memory:/], ['image=n\nmemory=g', /^memory:/], ['image=n\ncpus=1.2.3', /^cpus:/], ['image=n\ncpus=abc', /^cpus:/],
      ['image=n\ndns=$(x)', /^dns:/], ['image=n\nadd_host=nocolon', /^add_host:/], ['image=n\nadd_host=a b:1.1.1.1', /^add_host:/],
      ['image=n\nstop_timeout=-1', /^stop_timeout:/], ['image=n\nhealth_interval=30', /^health_interval:/], ['image=n\nhealth_retries=x', /^health_retries:/],
      ['image=n\ntty=yes', /^tty: use true or false/], ['image=n\nprivileged=1', /^privileged: use true or false/],
      ['image=n\npid=container:x', /^pid: only host/], ['image=n\nipc=private', /^ipc: only host/],
      ['image=n\ncap_add=sys admin', /^cap_add:/], ['image=n\ncap_drop=A;B', /^cap_drop:/],
      ['image=n\ndevice=/etc/passwd', /^device: must start with \/dev\//], ['image=n\ndevice=/dev/../etc', /^device:/],
      ['image=n\nsecurity_opt=a b', /^security_opt:/], ['image=n\nsysctl=a b=1', /^sysctl:/], ['image=n\ngpus=some', /^gpus:/],
      ['image=n\nentrypoint=\nentrypoint=x', /^entrypoint:/],
      [`image=n\nenv=A=${'x'.repeat(1001)}`, /longer than 1000/],
    ];
    for (const [blob, why] of cases) {
      const r = create(blob, 'true');
      expect(r.error ?? 'NO ERROR', JSON.stringify(blob).slice(0, 90)).toMatch(why);
      expect(r.done).toBeNull();
    }
    expect(dockerCalls()).toEqual([]);
  });
});

describe('risky settings', () => {
  const create = (settings: string, allow = 'false') => out('container_create.sh', { settings, allow_risky: allow });
  beforeEach(() => fake(`case "$1" in create) echo ${ID} ;; inspect) echo /web ;; esac`));
  const base = 'name=web\nimage=nginx\n';

  it.skipIf(!hasSh)('refuses each risky key without allow_risky, lists the reasons, and passes them with it', () => {
    const cases: [string, RegExp, string][] = [
      ['privileged=true', /: privileged$/, '--privileged'],
      ['pid=host', /host PID namespace/, '--pid=host'],
      ['ipc=host', /host IPC namespace/, '--ipc=host'],
      ['cap_add=SYS_ADMIN', /capability SYS_ADMIN/, '--cap-add=SYS_ADMIN'],
      ['device=/dev/ttyUSB0:/dev/ttyUSB0:rwm', /device \/dev\/ttyUSB0/, '--device=/dev/ttyUSB0:/dev/ttyUSB0:rwm'],
      ['security_opt=seccomp=unconfined', /security option seccomp=unconfined/, '--security-opt=seccomp=unconfined'],
      ['sysctl=net.ipv4.ip_forward=1', /sysctl net.ipv4.ip_forward/, '--sysctl=net.ipv4.ip_forward=1'],
      ['network=host', /host network/, '--network=host'],
    ];
    for (const [line, why, arg] of cases) {
      const refused = create(base + line);
      expect(refused.error, line).toMatch(/^needs the permission to use elevated container options: /);
      expect(refused.error, line).toMatch(why);
      expect(dockerCalls(), line).toEqual([]);
      for (const mode of ['true']) { // only the exact string true opens the gate
        const allowed = create(base + line, mode);
        expect(allowed.error, line).toBeNull();
        expect(dockerCalls().find((c) => c[0] === 'create'), line).toContain(arg);
        fs.writeFileSync(log, '');
      }
    }
    for (const gate of ['', 'false', 'TRUE', '1', 'yes']) expect(create(base + 'privileged=true', gate).error, gate).toMatch(/needs the permission/);
    expect(create(base + 'privileged=true\ncap_add=NET_ADMIN\nnetwork=host\nvolume=/etc:/x').error)
      .toBe('needs the permission to use elevated container options: privileged, capability NET_ADMIN, host network, host path /etc');
  });

  it.skipIf(!hasSh)('cap_drop, ordinary host paths, named volumes and bridge networks are not risky', () => {
    expect(create(base + 'cap_drop=ALL\ncap_drop=NET_RAW\nvolume=/srv/data:/d\nvolume=/etcetera:/e\nvolume=/usrlocal:/u\nvolume=/home/me/data:/h\nvolume=/home/me/.sshx:/h2\nvolume=/var/lib/dockerx:/v\nvolume=named:/n\nnetwork=bridge').error).toBeNull();
  });

  it.skipIf(!hasSh)('detects sensitive host paths, also through ".." and trailing parts', () => {
    const risky = ['/', '/etc', '/etc/', '/etc/ssh', '/root', '/root/.ssh', '/proc', '/proc/1', '/sys', '/boot', '/usr', '/usr/bin', '/var/lib/docker', '/var/lib/docker/volumes',
      '/var/run/docker.sock', '/run/docker.sock', '/opt/run/containerd.sock', '/srv/../etc', '/srv/data/../../etc/passwd', '/./etc', '//etc', '/etc/../', '/home/alice/.ssh', '/home/alice/.ssh/keys', '/srv/..', '/a/b/../../../etc'];
    for (const p of risky) {
      const r = create(`${base}volume=${p}:/x`);
      expect(r.error, p).toMatch(/needs the permission to use elevated container options: host path /);
      expect(create(`${base}volume=${p}:/x`, 'true').error, p).toBeNull();
    }
    for (const p of ['/srv', '/srv/etc', '/etcfoo', '/usrlocal', '/home', '/home/alice', '/home/alice/docs', '/var/lib', '/var/lib/other', '/opt/proc', '/tmp/..foo']) {
      expect(create(`${base}volume=${p}:/x`).error, p).toBeNull();
    }
  });

  it.skipIf(!hasSh)('follows a symbolic link to a sensitive place', () => {
    const link = path.join(bin, 'sneaky');
    try { fs.symlinkSync('/etc', link); } catch { return; }
    expect(create(`${base}volume=${link}:/x`).error).toMatch(/host path .*sneaky \(is \/etc\)/);
  });
});

describe('container_create flow', () => {
  const settings = 'name=web\nimage=nginx:1';
  const p = { settings, allow_risky: 'false' };

  it.skipIf(!hasSh)('pulls a missing image first, then creates and starts', () => {
    fake(`case "$1 $2" in "image inspect") exit 1 ;; "create "*) echo ${ID} ;; "inspect "*) echo /web ;; esac`);
    const r = parseScriptOutput(run('container_create.sh', p).stdout);
    expect(r.done).toBe('created web');
    expect(verbs()).toEqual(['image inspect', 'pull nginx:1', 'create --name=web', 'start ' + ID, 'inspect --format']);
    expect(r.progress).toMatchObject({ done: 4, total: 4 });
  });

  it.skipIf(!hasSh)('reports a failed pull, create or start with docker\'s own words, and removes a container that cannot start', () => {
    fake(`case "$1 $2" in "image inspect") exit 1 ;; pull*) echo 'denied: no such repo' >&2; exit 1 ;; esac`);
    expect(out('container_create.sh', p).error).toMatch(/pulling nginx:1 failed: denied: no such repo/);
    fake(`case "$1" in create) echo 'Conflict. The container name "/web" is already in use' >&2; exit 1 ;; esac`);
    expect(out('container_create.sh', p).error).toMatch(/creating the container failed: Conflict/);
    fake(`case "$1" in create) echo ${ID} ;; start) echo 'port is already allocated' >&2; exit 1 ;; esac`);
    expect(out('container_create.sh', p).error).toMatch(/could not be started: port is already allocated/);
    expect(verbs()).toContain('rm -f');
  });

  it.skipIf(!hasSh)('says when Docker is not available (and keeps exit status 0)', () => {
    noDocker();
    const r = run('container_create.sh', p);
    expect(r.status).toBe(0);
    expect(parseScriptOutput(r.stdout).error).toMatch(/Docker is not available/);
  });
});

describe('container_recreate', () => {
  /** The old container as `docker inspect` prints the facts (every line starts with the token found in the template). */
  const oldFacts = (extra = '', running = 'true') => `
tok=$(printf '%s' "$5" | sed -n 's/.*{{$T := "\\([^"]*\\)"}}.*/\\1/p')
printf '%s ID ${ID}\\n%s RUN ${running}\\n%s IMG nginx:old\\n%s LBL com.docker.compose.project=shop\\n%s LBL other=label\\n%s SHM 134217728\\n%s ULI nofile=100:200\\n%s GRP 5\\n%s OOM -100\\n%s RT runc\\n%s RPN on-failure 4\\n${extra}' $tok $tok $tok $tok $tok $tok $tok $tok $tok $tok $tok`;
  const dockerBody = (opts: { createFails?: boolean; startFails?: boolean; stopFails?: boolean; running?: string; stays?: string; leftover?: boolean } = {}) => `
case "$*" in
  *'$T :='*) ${oldFacts('', opts.running ?? 'true')} ;;
  *'State.Running'*) echo '${opts.stays ?? 'true false'}' ;;
  'inspect --type container --format {{.Id}} web-bosun-old') ${opts.leftover ? 'echo x' : 'exit 1'} ;;
esac
case "$1" in
  create) ${opts.createFails ? "echo 'bad config' >&2; exit 1" : `echo ${NEW}`} ;;
  stop) ${opts.stopFails ? "echo 'cannot stop' >&2; exit 1" : ':'} ;;
  start) if [ "$2" = ${NEW} ]; then ${opts.startFails ? "echo 'port in use' >&2; exit 1" : ':'}; fi ;;
esac
exit 0`;
  const p = (settings: string, allow = 'false') => ({ name: 'web', settings, allow_risky: allow });

  it.skipIf(!hasSh)('renames, creates with the copied settings, stops the old one, starts the new one and removes the old one last', () => {
    fake(dockerBody());
    const r = parseScriptOutput(run('container_recreate.sh', p('name=web\nimage=nginx:new\nenv=A=1\nrestart=on-failure\nnetwork=shop_default\n')).stdout);
    expect(r.error).toBeNull();
    expect(r.done).toBe('recreated web');
    expect(r.steps).toEqual(['Reading the container web', 'Renaming web to web-bosun-old', 'Creating the new container web', 'Stopping the old container and starting the new one', 'Checking that the new container stays running', 'Removing the old container']);
    const c = dockerCalls();
    expect(c.map((x) => x.slice(0, 2).join(' '))).toEqual([
      'inspect --type', 'image inspect', 'inspect --type', 'rename web', 'create --env=A=1', 'stop web-bosun-old', 'start ' + NEW, 'inspect --type', 'rm -f',
    ]);
    expect(c[3]).toEqual(['rename', 'web', 'web-bosun-old']);
    expect(c[4]).toEqual(expect.arrayContaining([
      '--env=A=1', '--network=shop_default', '--label=com.docker.compose.project=shop', '--ulimit=nofile=100:200', '--shm-size=134217728', '--group-add=5', '--oom-score-adj=-100',
      '--restart=on-failure:4', '--name=web', 'nginx:new',
    ]));
    expect(c[4]).not.toContain('--label=other=label');   // only the compose labels are copied; the others are the settings' business
    expect(c[8]).toEqual(['rm', '-f', 'web-bosun-old']);
  });

  it.skipIf(!hasSh)('keeps the current image and name when the settings do not give them; renaming is possible', () => {
    fake(dockerBody());
    expect(out('container_recreate.sh', p('env=A=1')).done).toBe('recreated web');
    expect(dockerCalls().find((x) => x[0] === 'create')!.slice(-2)).toEqual(['--name=web', 'nginx:old']);
    fs.writeFileSync(log, '');
    expect(out('container_recreate.sh', p('name=web2')).done).toBe('recreated web2');
    expect(dockerCalls().find((x) => x[0] === 'create')).toContain('--name=web2');
  });

  it.skipIf(!hasSh)('a failing create puts the old container back (renamed back, started when it ran) and never removes it', () => {
    fake(dockerBody({ createFails: true }));
    const r = out('container_recreate.sh', p('image=nginx:new'));
    expect(r.error).toMatch(/creating the new container failed: bad config \(the old container web was restored\)/);
    expect(verbs().map((v, i) => (i === 4 ? 'create' : v))).toEqual(['inspect --type', 'image inspect', 'inspect --type', 'rename web', 'create', 'rename web-bosun-old', 'start web']);
    expect(dockerCalls().some((x) => x[0] === 'rm' && x.includes('web-bosun-old'))).toBe(false);
    expect(dockerCalls().at(-1)).toEqual(['start', 'web']);
  });

  it.skipIf(!hasSh)('a failing start removes the new container and restores the old one', () => {
    fake(dockerBody({ startFails: true }));
    const r = out('container_recreate.sh', p('image=nginx:new'));
    expect(r.error).toMatch(/new container could not be started: port in use \(the old container web was restored\)/);
    const c = dockerCalls();
    const after = c.slice(c.findIndex((x) => x[0] === 'start' && x[1] === NEW) + 1);
    expect(after).toEqual([['rm', '-f', NEW], ['rename', 'web-bosun-old', 'web'], ['start', 'web']]);
  });

  it.skipIf(!hasSh)('a new container that does not stay running is rolled back; a stopped old container stays stopped', () => {
    fake(dockerBody({ stays: 'false false' }));
    expect(out('container_recreate.sh', p('env=A=1')).error).toMatch(/did not stay running/);
    fake(dockerBody({ stays: 'false false', running: 'false' }));
    fs.writeFileSync(log, '');
    out('container_recreate.sh', p('env=A=1'));
    expect(dockerCalls().some((x) => x[0] === 'stop')).toBe(false);
    expect(dockerCalls().at(-1)).toEqual(['rename', 'web-bosun-old', 'web']);    // no start: it was not running
  });

  it.skipIf(!hasSh)('a stop that fails restores too; a missing image is pulled before anything is touched; a leftover backup blocks', () => {
    fake(dockerBody({ stopFails: true }));
    expect(out('container_recreate.sh', p('env=A=1')).error).toMatch(/old container could not be stopped: cannot stop/);
    fake(`case "$1 $2" in "image inspect") exit 1 ;; pull*) echo 'not found' >&2; exit 1 ;; esac\n${dockerBody()}`);
    fs.writeFileSync(log, '');
    const r = out('container_recreate.sh', p('image=nope:1'));
    expect(r.error).toMatch(/pulling nope:1 failed \(the old container was not changed\): not found/);
    expect(dockerCalls().some((x) => x[0] === 'rename')).toBe(false);
    fake(dockerBody({ leftover: true }));
    expect(out('container_recreate.sh', p('env=A=1')).error).toMatch(/web-bosun-old exists/);
  });

  it.skipIf(!hasSh)('refuses risky settings without the permission before touching docker, and validates the name', () => {
    fake(dockerBody());
    expect(out('container_recreate.sh', p('privileged=true')).error).toMatch(/needs the permission/);
    expect(out('container_recreate.sh', { ...p('env=A=1'), name: 'bad name' }).error).toMatch(/invalid container name/);
    expect(dockerCalls()).toEqual([]);
    expect(out('container_recreate.sh', p('privileged=true', 'true')).error).toBeNull();
  });
});

describe('inspect (dataset)', () => {
  // What the real templates print: one line per fact, strings as JSON. (The templates themselves are checked against real Docker by hand.)
  const containerFacts = [
    `ID "${ID}"`, 'NAME "web"', 'IMAGE "nginx:1"', 'IMGID sha256:1234', 'STATE "running"',
    'ENV "PATH=/usr/bin"', 'ENV "A=say \\"hi\\" \\\\ ok"', 'ENV "B=2"',
    'CMDJ ["nginx","-g","daemon off;"]', 'EPJ ["/docker-entrypoint.sh"]', 'CMD "nginx"', 'CMD "-g"', 'CMD "daemon off;"', 'EP "/docker-entrypoint.sh"',
    'LABEL "maintainer=NGINX"', 'LABEL "com.docker.compose.project=shop"', 'LABEL "mine=1"',
    'PORT "127.0.0.1" "" "80/tcp"', 'PORT "" "8443" "443/tcp"', 'PORT "::" "9000" "90/udp"',
    'MOUNT "data:/data"', 'MOUNT "/srv/app:/app:ro"', 'BIND "/srv/app"', 'MOUNT "/etc:/hostetc"', 'BIND "/etc"', 'TMPFS "/run:size=10m"', 'TMPFS "/tmp"',
    'NETMODE "shop_default"', 'NETN "shop_default"', `ALIAS "shop_default" "${ID.slice(0, 12)}"`, 'ALIAS "shop_default" "web"', 'ALIAS "shop_default" "mine"',
    'RP "on-failure"', 'RPN 5', `HOSTNAME "${ID.slice(0, 12)}"`, 'USER ""', 'WORKDIR "/"', 'MEM 536870912', 'NANO 1500000000',
    'DNS "1.1.1.1"', 'EXTRAHOST "db:10.0.0.2"', 'LOGT "json-file"', 'LOGO "max-size=1m"', 'STOPSIG "SIGQUIT"', 'STOPTO 30',
    'TTY true', 'OPEN false', 'INIT true', 'RO false', 'HEALTHJ null',
    'PRIV false', 'PIDM ""', 'IPCM "private"', 'CAPADD "NET_ADMIN"', 'CAPDROP "NET_RAW"', 'DEVICE "/dev/null:/dev/n:rwm"', 'SECOPT "seccomp=unconfined"', 'SYSCTL "net.ipv4.ip_forward=1"', 'GPU -1',
    'PRES "--ulimit=nofile=100:200"', 'SHM 134217728', 'OOM -5', 'CGP ""', 'RT "runc"', 'UNM "links"', 'CPUSHARES 512', 'PIDSLIM 100', 'MEMRES 0', 'UTS ""', 'USERNS ""',
  ].join('\n');
  const imageFacts = ['ENV "PATH=/usr/bin"', 'CMDJ ["nginx","-g","daemon off;"]', 'EPJ ["/docker-entrypoint.sh"]', 'LABEL "maintainer=NGINX"', 'USER ""', 'WORKDIR "/"', 'STOPSIG "SIGQUIT"', 'HEALTHJ null'].join('\n');
  const fakeInspect = (c = containerFacts, i = imageFacts) => {
    fs.writeFileSync(path.join(bin, 'c.txt'), c + '\n'); fs.writeFileSync(path.join(bin, 'i.txt'), i + '\n');
    fake(`case "$1" in inspect) cat "${path.join(bin, 'c.txt')}" ;; image) cat "${path.join(bin, 'i.txt')}" ;; esac`);
  };

  it.skipIf(!hasSh)('prints the documented JSON shape, leaving out what the image already provides', () => {
    fakeInspect();
    const r = run('inspect.sh', { name: 'web' });
    expect(r.status).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(Object.keys(j)).toEqual(['name', 'image', 'state', 'settings', 'risky', 'risky_text', 'preserved', 'preserved_text', 'readonly_note']);
    expect(j).toMatchObject({ name: 'web', image: 'nginx:1', state: 'running' });
    expect(Object.keys(j.settings)).toEqual(['name', 'image', 'cmd', 'entrypoint', 'env', 'port', 'volume', 'tmpfs', 'label', 'network', 'network_alias', 'restart', 'hostname', 'user', 'workdir', 'memory', 'cpus', 'dns', 'add_host', 'log_driver', 'log_opt', 'stop_signal', 'stop_timeout', 'tty', 'interactive', 'init', 'read_only', 'health_cmd', 'health_interval', 'health_timeout', 'health_retries', 'privileged', 'pid', 'ipc', 'cap_add', 'cap_drop', 'device', 'security_opt', 'sysctl', 'gpus']);
    expect(j.settings).toMatchObject({
      name: 'web', image: 'nginx:1', cmd: [], entrypoint: [],                       // same as the image: not copied
      env: ['A=say "hi" \\ ok', 'B=2'], label: ['mine=1'],                           // PATH and the maintainer label are the image's
      port: ['127.0.0.1::80/tcp', '8443:443/tcp', '[::]:9000:90/udp'],
      volume: ['data:/data', '/srv/app:/app:ro', '/etc:/hostetc'], tmpfs: ['/run:size=10m', '/tmp'],
      network: 'shop_default', network_alias: ['mine'], restart: 'on-failure', hostname: '', user: '', workdir: '', memory: '512m', cpus: '1.5',
      dns: ['1.1.1.1'], add_host: ['db:10.0.0.2'], log_driver: 'json-file', log_opt: ['max-size=1m'], stop_signal: '', stop_timeout: '30',
      tty: 'true', interactive: 'false', init: 'true', read_only: 'false', health_cmd: '', health_interval: '', health_timeout: '', health_retries: '',
      privileged: 'false', pid: '', ipc: '', cap_add: ['NET_ADMIN'], cap_drop: ['NET_RAW'], device: ['/dev/null:/dev/n:rwm'], security_opt: ['seccomp=unconfined'], sysctl: ['net.ipv4.ip_forward=1'], gpus: 'all',
    });
    expect(j.risky).toEqual(['host path /etc', 'capability NET_ADMIN', 'device /dev/null:/dev/n:rwm', 'security option seccomp=unconfined', 'sysctl net.ipv4.ip_forward']);
    expect(j.risky_text).toBe(j.risky.join(', '));
    expect(j.preserved).toEqual(['label com.docker.compose.project=shop', '--ulimit=nofile=100:200', 'restart on-failure max retries 5', '--shm-size=134217728', '--oom-score-adj=-5']);
    expect(j.preserved_text).toBe(j.preserved.join(', '));
    expect(j.readonly_note).toBe('Not shown here and not kept when the container is edited: links, cpu-shares, pids-limit.');
  });

  it.skipIf(!hasSh)('shows what differs from the image (command, entrypoint, user, health check) and a cleared entrypoint', () => {
    fakeInspect([
      'ID "x"'.replace('x', ID), 'NAME "db"', 'IMAGE "pg"', 'IMGID sha256:1', 'STATE "exited"', 'CMDJ ["serve","--x"]', 'EPJ null', 'CMD "serve"', 'CMD "--x"',
      'NETMODE "bridge"', 'NETN "bridge"', 'USER "70"', 'WORKDIR "/srv"', 'STOPSIG "SIGINT"', 'RP ""', 'RPN 0', 'HOSTNAME "custom"',
      'HEALTHJ {"Test":["CMD-SHELL","pg_isready"]}', 'HKIND "CMD-SHELL"', 'HARG "pg_isready"', 'HINT 30000000000', 'HTO 500000000', 'HRET 3', 'HSTART 0', 'LOGT "json-file"',
    ].join('\n'), ['CMDJ ["postgres"]', 'EPJ ["docker-entrypoint.sh"]', 'USER ""', 'WORKDIR ""', 'STOPSIG "SIGTERM"', 'HEALTHJ null'].join('\n'));
    const j = JSON.parse(run('inspect.sh', { name: 'db' }).stdout);
    expect(j.state).toBe('exited');
    expect(j.settings).toMatchObject({ cmd: ['serve', '--x'], entrypoint: [''], user: '70', workdir: '/srv', stop_signal: 'SIGINT', hostname: 'custom', restart: 'no', network: 'bridge', network_alias: [],
      health_cmd: 'pg_isready', health_interval: '30s', health_timeout: '500ms', health_retries: '3', log_driver: '', memory: '', cpus: '' });
    expect(j.risky).toEqual([]);
    expect(j.risky_text).toBe('');
  });

  it.skipIf(!hasSh)('host network and privileged containers are risky, and an unknown or damaged name is refused', () => {
    fakeInspect(['ID "x"', 'NAME "h"', 'IMAGE "i"', 'IMGID sha256:1', 'STATE "running"', 'NETMODE "host"', 'PRIV true', 'PIDM "host"', 'IPCM "host"', 'HOSTNAME "myhost"'].join('\n'), 'CMDJ null');
    const j = JSON.parse(run('inspect.sh', { name: 'h' }).stdout);
    expect(j.risky).toEqual(['host network', 'privileged', 'host PID namespace', 'host IPC namespace']);
    expect(j.settings).toMatchObject({ network: 'host', privileged: 'true', pid: 'host', ipc: 'host', hostname: '' });   // a host name makes no sense with the host network
    noDocker();
    const gone = run('inspect.sh', { name: 'h' });
    expect(gone.status).toBe(3);
    fake('case "$1" in inspect) exit 1 ;; esac');
    expect(run('inspect.sh', { name: 'zzz' }).status).toBe(1);
    expect(run('inspect.sh', { name: '../x' }).status).toBe(1);
  });

  it.skipIf(!hasSh)('what inspect shows is accepted by container_recreate as it is (the round trip), risky parts need the permission', () => {
    fakeInspect();
    const j = JSON.parse(run('inspect.sh', { name: 'web' }).stdout);
    const blob = Object.entries(j.settings as Record<string, string | string[]>).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => `${k}=${x}`) : v === '' ? [] : [`${k}=${v}`])).join('\n');
    expect(out('container_recreate.sh', { name: 'web', settings: blob, allow_risky: 'false' }).error).toMatch(/needs the permission/);
    const safe = blob.split('\n').filter((l) => !/^(cap_add|device|security_opt|sysctl)=|^volume=\/etc/.test(l)).join('\n');
    const r = out('container_recreate.sh', { name: 'web', settings: safe, allow_risky: 'false' });
    expect(r.error, safe).not.toMatch(/unknown setting|invalid|use /);
  });
});

describe('datasets: images, volumes, networks, system', () => {
  const T = '\t';
  it.skipIf(!hasSh)('images: valid JSON with container counts, dangling images and ISO times', () => {
    fake(`case "$1" in
  ps) echo c1; echo c2 ;;
  inspect) echo sha256:aaa; echo sha256:aaa ;;
  image) printf '%s\\n' '"sha256:aaa"${T}"nginx"${T}"1.25"${T}"187MB"${T}2025-01-02 03:04:05 +0200 CEST' '"sha256:bbb"${T}"<none>"${T}"<none>"${T}"1GB"${T}2025-01-02 03:04:05 +0000 UTC' '"sha256:ccc"${T}"x/y"${T}"<none>"${T}"2MB"${T}garbage' ;;
esac`);
    const r = run('images.sh');
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([
      { id: 'sha256:aaa', short_id: 'aaa', repo: 'nginx', tag: '1.25', ref: 'nginx:1.25', size: '187MB', created: '2025-01-02T03:04:05+02:00', created_text: '2025-01-02 03:04', containers: 2, dangling: false },
      { id: 'sha256:bbb', short_id: 'bbb', repo: '', tag: '', ref: 'sha256:bbb', size: '1GB', created: '2025-01-02T03:04:05+00:00', created_text: '2025-01-02 03:04', containers: 0, dangling: true },
      { id: 'sha256:ccc', short_id: 'ccc', repo: 'x/y', tag: '', ref: 'x/y', size: '2MB', created: 'garbage', created_text: 'garbage', containers: 0, dangling: false },
    ]);
    fake('case "$1" in image) exit 0 ;; esac');
    expect(JSON.parse(run('images.sh').stdout)).toEqual([]);
  });

  it.skipIf(!hasSh)('volumes: sizes from df, containers from the mounts of all containers', () => {
    fake(`case "$1" in
  volume) if [ "$2" = ls ]; then echo v1; echo v2; else printf '%s\\n' '"v1"${T}"local"${T}"/var/lib/docker/volumes/v1/_data"${T}"2025-01-01T00:00:00Z"' '"v2"${T}"local"${T}"/m/v2"${T}"2025-01-02T00:00:00Z"'; fi ;;
  system) printf 'v1${T}1.5MB\\n' ;;
  ps) echo 'v1,/host/path'; echo 'v1'; echo '' ;;
esac`);
    const r = run('volumes.sh');
    expect(JSON.parse(r.stdout)).toEqual([
      { name: 'v1', driver: 'local', mountpoint: '/var/lib/docker/volumes/v1/_data', size: '1.5MB', containers: 2, created: '2025-01-01T00:00:00Z' },
      { name: 'v2', driver: 'local', mountpoint: '/m/v2', size: '', containers: 0, created: '2025-01-02T00:00:00Z' },
    ]);
    fake('case "$1 $2" in "volume ls") exit 0 ;; esac');
    expect(JSON.parse(run('volumes.sh').stdout)).toEqual([]);
  });

  it.skipIf(!hasSh)('networks: one JSON object per network from the inspect template, joined into an array', () => {
    fake(`case "$1 $2" in
  "network ls") echo n1; echo n2 ;;
  "network inspect") echo '{"id":"n1","name":"bridge","driver":"bridge","scope":"local","subnet":"172.17.0.0/16","gateway":"172.17.0.1","containers":2,"internal":false}'; echo '{"id":"n2","name":"x\\"y","driver":"overlay","scope":"swarm","subnet":"","gateway":"","containers":0,"internal":true}' ;;
esac`);
    const j = JSON.parse(run('networks.sh').stdout);
    expect(j).toHaveLength(2);
    expect(j[1]).toMatchObject({ name: 'x"y', internal: true, scope: 'swarm' });
    expect(dockerCalls().find((c) => c[1] === 'inspect')).toContain('n2');
  });

  it.skipIf(!hasSh)('system: versions, counts, disk sizes and the compose flag', () => {
    fake(`case "$1" in
  version) echo '"29.9.2"' ;;
  info) case "$*" in *Plugins*) printf 'V local\nV bsbt-driver\nV bad name\nN bridge\nN host\nN overlay\nN null\nX other\n' ;; *) echo '8 7 0 1 36' ;; esac ;;
  system) printf 'Images|55.11GB\\nContainers|182.1MB\\nLocal Volumes|400.5MB\\nBuild Cache|122.8GB\\n' ;;
  compose) exit 0 ;;
esac`);
    expect(JSON.parse(run('system.sh').stdout)).toEqual({ version: '29.9.2', containers: { total: 8, running: 7, paused: 0, stopped: 1 }, images: 36, disk: { images: '55.11GB', containers: '182.1MB', volumes: '400.5MB', cache: '122.8GB' }, compose: true, drivers: { volume: ['local', 'bsbt-driver'], network: ['bridge', 'host', 'overlay', 'null'] } });
    fake(`case "$1" in compose) exit 1 ;; info) echo garbage ;; esac`);
    expect(JSON.parse(run('system.sh').stdout)).toMatchObject({ version: '', compose: false, images: 0, containers: { total: 0 }, drivers: { volume: ['local'], network: ['bridge', 'host', 'none'] } });
  });

  it.skipIf(!hasSh)('every dataset says when Docker is not available (exit 3, nothing on stdout)', () => {
    noDocker();
    for (const f of ['images.sh', 'volumes.sh', 'networks.sh', 'system.sh', 'stacks.sh']) {
      const r = run(f);
      expect(r.status, f).toBe(3);
      expect(r.stdout, f).toBe('');
      expect(r.stderr, f).toMatch(/Docker is not available/);
    }
  });
});

describe('simple actions', () => {
  const ok = () => fake('case "$1 $2" in "image prune") echo "Total reclaimed space: 1.5GB" ;; esac');
  it.skipIf(!hasSh)('run exactly the docker command, pass the flags only for the string true, and report DONE', () => {
    ok();
    expect(out('image_remove.sh', { ref: 'nginx:1', force: 'true' }).done).toBe('removed nginx:1');
    expect(out('image_remove.sh', { ref: 'nginx:1', force: 'false' }).done).toBe('removed nginx:1');
    expect(out('image_prune.sh', { all: 'true' }).done).toBe('removed 0 images, reclaimed 1.5GB');
    out('image_prune.sh', { all: 'false' });
    expect(out('volume_create.sh', { name: 'v1', driver: 'local' }).done).toBe('created volume v1');
    out('volume_create.sh', { name: 'v2', driver: '-' });
    out('volume_remove.sh', { name: 'v1' });
    out('volume_prune.sh');
    out('network_create.sh', { name: 'n1', driver: 'bridge', subnet: '10.1.0.0/24', gateway: '10.1.0.1' });
    out('network_create.sh', { name: 'n2', driver: '-', subnet: '-', gateway: '-' });
    out('network_remove.sh', { name: 'n1' });
    out('network_prune.sh');
    out('container_remove.sh', { name: 'web', volumes: 'true' });
    out('container_remove.sh', { name: 'web', volumes: 'false' });
    expect(dockerCalls()).toEqual([
      ['rmi', '-f', 'nginx:1'], ['rmi', 'nginx:1'],
      ['image', 'ls', '-a', '-q', '--no-trunc'], ['image', 'prune', '-f', '-a'], ['image', 'ls', '-a', '-q', '--no-trunc'],
      ['image', 'ls', '-a', '-q', '--no-trunc'], ['image', 'prune', '-f'], ['image', 'ls', '-a', '-q', '--no-trunc'],
      ['volume', 'create', '--driver', 'local', 'v1'], ['volume', 'create', 'v2'], ['volume', 'rm', 'v1'], ['volume', 'prune', '-f'],
      ['network', 'create', '--driver', 'bridge', '--subnet', '10.1.0.0/24', '--gateway', '10.1.0.1', 'n1'], ['network', 'create', 'n2'], ['network', 'rm', 'n1'], ['network', 'prune', '-f'],
      ['rm', '-f', '-v', 'web'], ['rm', '-f', 'web'],
    ]);
  });

  it.skipIf(!hasSh)('refuse names and references that are not plain, before docker is called', () => {
    ok();
    const bad: [string, Record<string, string>, RegExp][] = [
      ['container_remove.sh', { name: '$(x)', volumes: 'false' }, /invalid container name/], ['container_remove.sh', { name: '-rf', volumes: 'false' }, /invalid container name/],
      ['image_pull.sh', { ref: 'a b' }, /invalid image reference/], ['image_pull.sh', { ref: '-x' }, /invalid image reference/], ['image_remove.sh', { ref: 'x;y', force: 'false' }, /invalid image reference/],
      ['volume_create.sh', { name: 'a/b', driver: '-' }, /invalid volume name/], ['volume_create.sh', { name: 'ok', driver: '-x' }, /invalid volume driver/], ['volume_remove.sh', { name: '..' }, /invalid volume name/],
      ['network_create.sh', { name: 'a b', driver: '-', subnet: '-', gateway: '-' }, /invalid network name/],
      ['network_create.sh', { name: 'n', driver: '-', subnet: '10.0.0.0', gateway: '-' }, /subnet/], ['network_create.sh', { name: 'n', driver: '-', subnet: '10.0.0.0/8;x', gateway: '-' }, /invalid subnet/],
      ['network_create.sh', { name: 'n', driver: '-', subnet: '-', gateway: '10.0.0.1' }, /needs a subnet/], ['network_create.sh', { name: 'n', driver: 'a b', subnet: '-', gateway: '-' }, /driver/],
      ['network_remove.sh', { name: 'a;b' }, /invalid network name/],
    ];
    for (const [f, params, why] of bad) expect(out(f, params).error, f + JSON.stringify(params)).toMatch(why);
    expect(dockerCalls()).toEqual([]);
  });

  it.skipIf(!hasSh)('report docker\'s own message on failure, and a missing Docker', () => {
    fake('echo "Error response from daemon: network n1 has active endpoints" >&2; exit 1');
    const r = run('network_remove.sh', { name: 'n1' });
    expect(r.status).toBe(0);
    expect(parseScriptOutput(r.stdout).error).toMatch(/has active endpoints/);
    noDocker();
    for (const [f, p] of [['volume_prune.sh', {}], ['network_prune.sh', {}], ['image_prune.sh', { all: 'false' }], ['image_pull.sh', { ref: 'a' }]] as const) {
      expect(parseScriptOutput(run(f, p).stdout).error, f).toMatch(/Docker is not available/);
    }
  });

  it.skipIf(!hasSh)('image_pull reports progress per layer and the failure message', () => {
    fake(`case "$1" in pull) echo 'a: Pulling fs layer'; echo 'b: Pulling fs layer'; echo 'a: Pull complete'; echo 'b: Pull complete'; echo 'Status: Downloaded' ;; esac`);
    const r = parseScriptOutput(run('image_pull.sh', { ref: 'nginx:1' }).stdout);
    expect(r.done).toBe('pulled nginx:1');
    expect(r.progress).toMatchObject({ done: 1, total: 1 });
    expect(dockerCalls()).toEqual([['pull', 'nginx:1']]);
    fake(`case "$1" in pull) echo 'Error response from daemon: manifest unknown' >&2; exit 1 ;; esac`);
    expect(parseScriptOutput(run('image_pull.sh', { ref: 'nginx:nope' }).stdout).error).toMatch(/manifest unknown/);
  });
});

describe('stacks', () => {
  const stackDir = (n: string) => path.join(home, 'bosun-stacks', n);
  const shDir = (n: string) => sp(stackDir(n));
  const seed = (n: string, files: Record<string, string>) => {
    fs.mkdirSync(stackDir(n), { recursive: true });
    for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(stackDir(n), f)), { recursive: true }); fs.writeFileSync(path.join(stackDir(n), f), c); }
  };
  const yaml = 'services:\n  web:\n    image: nginx:alpine\n    environment:\n      A: "q\\\\\\"x"\n\ttab: 1\n';

  it.skipIf(!hasSh)('stacks: compose projects by label merged with Bosun\'s records, valid JSON whatever the files hold', () => {
    seed('mine', { 'bosun.meta': 'source=git\nrepo=https://github.com/o/r\nbranch=main\nfile=deploy/compose.yaml\nupdated=2025-01-02T03:04:05Z\n' });
    seed('idle', { 'bosun.meta': 'source=editor\nrepo=\nbranch=\nfile=\nupdated=2025-02-02T00:00:00Z\n' });
    seed('weird', { 'bosun.meta': 'source=git\nrepo=a"b\\c\nbranch=x\tY\nfile=\nupdated=now\n' });
    seed('Bad Name', { 'bosun.meta': 'source=git\n' });
    const t = '\t';
    fake(`case "$1" in ps) printf 'mine${t}web${t}running\\nmine${t}db${t}exited\\nmine${t}web${t}running\\next${t}app${t}running\\next${t}app2${t}running\\n' ;; esac`);
    const j = JSON.parse(run('stacks.sh').stdout);
    expect(j.map((s: { name: string }) => s.name)).toEqual(['ext', 'idle', 'mine', 'weird']);
    expect(j.find((s: { name: string }) => s.name === 'mine')).toEqual({ name: 'mine', status: 'partial', services: 2, source: 'git', repo: 'https://github.com/o/r', branch: 'main', file: 'deploy/compose.yaml', updated: '2025-01-02T03:04:05Z' });
    expect(j.find((s: { name: string }) => s.name === 'ext')).toEqual({ name: 'ext', status: 'running', services: 2, source: 'external', repo: '', branch: '', file: '', updated: '' });
    expect(j.find((s: { name: string }) => s.name === 'idle')).toMatchObject({ status: 'stopped', services: 0, source: 'editor' });
    expect(j.find((s: { name: string }) => s.name === 'weird')).toMatchObject({ repo: 'a"b\\c', branch: 'xY' });
    fs.rmSync(path.join(home, 'bosun-stacks'), { recursive: true });
    fake('exit 0');
    expect(JSON.parse(run('stacks.sh').stdout)).toEqual([]);
  });

  it.skipIf(!hasSh)('stack_get: the stored yaml and .env as JSON strings; git files only from inside the checkout; external from its config file', () => {
    seed('web', { 'compose.yaml': yaml, '.env': 'A=1\nB="x y"\n', 'bosun.meta': 'source=editor\nrepo=\nbranch=\nfile=\nupdated=x\n' });
    fake('exit 0');
    const j = JSON.parse(run('stack_get.sh', { name: 'web' }).stdout);
    expect(j).toEqual({ name: 'web', source: 'editor', repo: '', branch: '', file: '', yaml, env: 'A=1\nB="x y"\n', override: '' });
    seed('g', { 'repo/deploy/compose.yaml': 'services: {}\n', 'bosun.meta': 'source=git\nrepo=https://github.com/o/r\nbranch=main\nfile=deploy/compose.yaml\nupdated=x\n' });
    expect(JSON.parse(run('stack_get.sh', { name: 'g' }).stdout)).toMatchObject({ source: 'git', repo: 'https://github.com/o/r', yaml: 'services: {}\n', env: '' });
    // a compose file that is a link out of the checkout is not read
    fs.rmSync(path.join(stackDir('g'), 'repo', 'deploy', 'compose.yaml'));
    try { fs.symlinkSync('/etc/hostname', path.join(stackDir('g'), 'repo', 'deploy', 'compose.yaml')); expect(JSON.parse(run('stack_get.sh', { name: 'g' }).stdout).yaml).toBe(''); } catch { /* no symlinks here */ }
    // external
    const ext = path.join(bin, 'ext.yaml'); fs.writeFileSync(ext, 'services: {x: {}}\n');
    fake(`case "$1" in compose) echo '[{"Name":"other","Status":"running(1)","ConfigFiles":"/nope"},{"Name":"ext","Status":"running(1)","ConfigFiles":"${sp(ext)},/more.yaml"}]' ;; ps) exit 0 ;; esac`);
    expect(JSON.parse(run('stack_get.sh', { name: 'ext' }).stdout)).toEqual({ name: 'ext', source: 'external', repo: '', branch: '', file: '', yaml: 'services: {x: {}}\n', env: '', override: '' });
    fake('case "$1" in compose) echo "[]" ;; esac');
    const none = run('stack_get.sh', { name: 'ghost' });
    expect(none.status).toBe(1);
    expect(none.stdout).toBe('');
    expect(run('stack_get.sh', { name: '../x' }).status).toBe(1);
  });

  // `docker compose config --format json` as compose prints it (one key per line, two spaces per level)
  const config = (service: string, top = '') => `{
  "name": "demo",
  "services": {
    "web": {
      "image": "nginx",
${service}
      "environment": {
        "privileged": "true",
        "X": "\\"privileged\\": true"
      }
    }
  }${top}
}`;
  const composeFake = (cfg: string, extra = '') => {
    fs.writeFileSync(path.join(bin, 'cfg.json'), cfg);
    fake(`case "$1 $2" in "compose version") echo v2 ;; esac
case "$*" in *' config --format json'*) cat "${path.join(bin, 'cfg.json')}" ;; esac
${extra}
exit 0`);
  };
  const deploy = (o: Record<string, string> = {}, env: Record<string, string> = {}) => run('stack_deploy.sh', {
    name: 'demo', source: 'editor', yaml: 'services:\n  web:\n    image: nginx\n', env: 'FOO=bar', repo: '-', branch: '-', file: '-', pull: 'false', allow_risky: 'false', ...o,
  }, env);

  it.skipIf(!hasSh)('stack_deploy (editor): checks with compose config, stores the files and record, then up -d --remove-orphans', () => {
    composeFake(config('      "ports": []'));
    const r = parseScriptOutput(deploy().stdout);
    expect(r.error).toBeNull();
    expect(r.done).toBe('deployed demo');
    const d = stackDir('demo');
    const sd = shDir('demo');
    expect(fs.readFileSync(path.join(d, 'compose.yaml'), 'utf8')).toBe('services:\n  web:\n    image: nginx\n');
    expect(fs.readFileSync(path.join(d, '.env'), 'utf8')).toBe('FOO=bar\n');
    expect(fs.existsSync(path.join(d, 'compose.yaml.new'))).toBe(false);
    expect(fs.readFileSync(path.join(d, 'bosun.meta'), 'utf8')).toMatch(/^source=editor\nrepo=\nbranch=\nfile=\nupdated=\d{4}-\d\d-\d\dT[\d:]+Z\n$/);
    const c = dockerCalls().filter((x) => x[0] === 'compose' && x[1] !== 'version');
    expect(c[0]).toEqual(['compose', '-p', 'demo', '--project-directory', sd, '-f', sd + '/compose.yaml.new', '--env-file', sd + '/.env.new', 'config', '--format', 'json']);
    expect(c[1]).toEqual(['compose', '-p', 'demo', '--project-directory', sd, '-f', sd + '/compose.yaml', '--env-file', sd + '/.env', 'up', '-d', '--remove-orphans']);
    expect(c).toHaveLength(2);
    // pull=true pulls first; no env text means no .env at all (and a stale one is removed)
    fs.writeFileSync(log, '');
    deploy({ pull: 'true', env: '' });
    expect(fs.existsSync(path.join(d, '.env'))).toBe(false);
    expect(dockerCalls().filter((x) => x[1] === '-p').map((x) => x.slice(-1)[0] === 'json' ? 'config' : x[x.length - 1] === '--remove-orphans' ? 'up' : x.slice(-1)[0])).toEqual(['config', 'pull', 'up']);
  });

  it.skipIf(!hasSh)('stack_deploy refuses an invalid file or risky options (nothing stored, nothing started), and lets them through with allow_risky', () => {
    const risky: [string, RegExp][] = [
      ['      "privileged": true', /privileged/],
      ['      "network_mode": "host"', /host network/],
      ['      "pid": "host"', /host PID namespace/],
      ['      "ipc": "host"', /host IPC namespace/],
      ['      "cap_add": [\n        "SYS_ADMIN"\n      ]', /capability SYS_ADMIN/],
      ['      "devices": [\n        {\n          "source": "/dev/ttyUSB0",\n          "target": "/dev/x"\n        }\n      ]', /device \/dev\/ttyUSB0/],
      ['      "security_opt": [\n        "seccomp=unconfined"\n      ]', /security option seccomp=unconfined/],
      ['      "sysctls": {\n        "net.ipv4.ip_forward": "1"\n      }', /sysctl net.ipv4.ip_forward/],
      ['      "volumes": [\n        {\n          "type": "bind",\n          "source": "/var/run/docker.sock",\n          "target": "/s"\n        }\n      ]', /host path \/var\/run\/docker.sock/],
      ['      "volumes": [\n        {\n          "type": "bind",\n          "source": "/srv/../etc",\n          "target": "/s"\n        }\n      ]', /host path \/srv\/..\/etc/],
      ['      "volumes": [\n        "/etc/ssh:/s:ro"\n      ]', /host path \/etc\/ssh/],
    ];
    for (const [svc, why] of risky) {
      fs.writeFileSync(log, '');
      composeFake(config(svc));
      const r = parseScriptOutput(deploy().stdout);
      expect(r.error, svc).toMatch(/^needs the permission to use elevated container options: /);
      expect(r.error, svc).toMatch(why);
      expect(fs.existsSync(stackDir('demo')), svc).toBe(false);
      expect(dockerCalls().some((x) => x.includes('up')), svc).toBe(false);
      expect(parseScriptOutput(deploy({ allow_risky: 'true' }).stdout).done, svc).toBe('deployed demo');
      fs.rmSync(stackDir('demo'), { recursive: true, force: true });
    }
    // the same words as values, or an ordinary bind mount, are not risky
    composeFake(config('      "volumes": [\n        {\n          "type": "bind",\n          "source": "/srv/data",\n          "target": "/etc"\n        },\n        {\n          "type": "volume",\n          "source": "/etc",\n          "target": "/x"\n        }\n      ]', ',\n  "volumes": {\n    "ok": {\n      "name": "demo_ok"\n    }\n  }'));
    expect(parseScriptOutput(deploy().stdout).error).toBeNull();
    // a named volume that is really a bind of a sensitive host path
    fs.rmSync(stackDir('demo'), { recursive: true, force: true });
    composeFake(config('', ',\n  "volumes": {\n    "sneaky": {\n      "name": "demo_sneaky",\n      "driver_opts": {\n        "device": "/etc",\n        "o": "bind"\n      }\n    }\n  }'));
    expect(parseScriptOutput(deploy().stdout).error).toMatch(/host path \/etc/);
    // an invalid compose file
    fake('case "$1 $2" in "compose version") exit 0 ;; esac\ncase "$*" in *config*) echo "services.web.image must be a string" >&2; exit 1 ;; esac');
    expect(parseScriptOutput(deploy().stdout).error).toMatch(/the compose file is not valid: services.web.image must be a string/);
    expect(fs.existsSync(stackDir('demo'))).toBe(false);
  });

  it.skipIf(!hasSh)('stack_deploy keeps the previous files when a later deployment is refused', () => {
    composeFake(config('      "ports": []'));
    deploy();
    composeFake(config('      "privileged": true'));
    expect(parseScriptOutput(deploy({ yaml: 'services: {changed: {}}\n' }).stdout).error).toMatch(/needs the permission/);
    expect(fs.readFileSync(path.join(stackDir('demo'), 'compose.yaml'), 'utf8')).toBe('services:\n  web:\n    image: nginx\n');
    expect(fs.existsSync(path.join(stackDir('demo'), 'compose.yaml.new'))).toBe(false);
  });

  it.skipIf(!hasSh)('stack_deploy validates names and parameters, and says when compose is missing', () => {
    composeFake(config(''));
    const bad: [Record<string, string>, RegExp][] = [
      [{ name: 'Demo' }, /invalid stack name/], [{ name: '-x' }, /invalid stack name/], [{ name: 'a/b' }, /invalid stack name/], [{ name: '..' }, /invalid stack name/], [{ name: 'a'.repeat(64) }, /at most 63/],
      [{ source: 'ftp' }, /editor or git/], [{ yaml: '  \n' }, /compose file is empty/],
      [{ source: 'git', repo: 'http://github.com/o/r', branch: 'main', file: 'c.yaml' }, /https/], [{ source: 'git', repo: 'https://github.com/o/r', branch: '-', file: 'c.yaml' }, /branch/],
      [{ source: 'git', repo: 'https://github.com/o/r', branch: 'main', file: '-' }, /file:/], [{ source: 'git', repo: '-', branch: 'main', file: 'c.yaml' }, /repo:/],
      [{ source: 'git', repo: 'https://github.com/o/r', branch: 'a..b', file: 'c.yaml' }, /branch/], [{ source: 'git', repo: 'https://github.com/o/r', branch: '-x', file: 'c.yaml' }, /branch/],
      [{ source: 'git', repo: 'https://github.com/o/r', branch: 'main', file: '/etc/x' }, /file:/], [{ source: 'git', repo: 'https://github.com/o/r', branch: 'main', file: '../x.yaml' }, /file:/],
      [{ source: 'git', repo: 'https://github.com/o/../x', branch: 'main', file: 'c.yaml' }, /repo: invalid path/], [{ source: 'git', repo: 'https://-evil.com/o/r', branch: 'main', file: 'c.yaml' }, /invalid host/],
      [{ source: 'git', repo: 'https://github.com/o/r;touch x', branch: 'main', file: 'c.yaml' }, /repo: invalid path/], [{ source: 'git', repo: 'https://user:pw@github.com/o/r', branch: 'main', file: 'c.yaml' }, /invalid host/],
      [{ source: 'git', repo: 'https://github.com/o/r', branch: 'ma in', file: 'c.yaml' }, /branch/], [{ source: 'git', repo: 'https://github.com/o/r', branch: 'main', file: 'a b.yaml' }, /file:/],
    ];
    for (const [o, why] of bad) expect(parseScriptOutput(deploy(o).stdout).error, JSON.stringify(o)).toMatch(why);
    expect(fs.existsSync(path.join(home, 'bosun-stacks', 'demo'))).toBe(false);
    fake('case "$1 $2" in "compose version") exit 1 ;; esac');
    expect(parseScriptOutput(deploy().stdout).error).toMatch(/Docker Compose .* is not installed/);
  });

  describe('git source', () => {
    const TOKEN = 'ghp_SECRET0123456789abcdef';
    const fakeGit = () => fakeCmd('git', `
{ echo "ENV GIT_CONFIG_COUNT=$GIT_CONFIG_COUNT"; echo "ENV GIT_CONFIG_KEY_0=$GIT_CONFIG_KEY_0"; echo "ENV GIT_CONFIG_VALUE_0=$GIT_CONFIG_VALUE_0"; echo "ENV GIT_CONFIG_KEY_1=$GIT_CONFIG_KEY_1"; echo "ENV GIT_CONFIG_VALUE_1=$GIT_CONFIG_VALUE_1"; echo "ENV GIT_ALLOW_PROTOCOL=$GIT_ALLOW_PROTOCOL"; echo "ENV SECRET=$BOSUN_SECRET_git_token"; } >> "$LOG"
case "$1" in
  clone) for last; do :; done; mkdir -p "$last/.git" "$last/deploy"; printf 'services:\\n  web:\\n    image: nginx\\n' > "$last/deploy/compose.yaml"; echo "Cloning into '$last'..." >&2 ;;
  *) case "$*" in *'config --get remote.origin.url'*) echo https://github.com/o/r ;; *'rev-parse'*) echo deadbeef ;; esac ;;
esac
exit 0`);
    const g = { source: 'git', yaml: '', env: '', repo: 'https://github.com/o/r', branch: 'main', file: 'deploy/compose.yaml' };
    const gitCalls = () => calls().filter((c) => c[0] === 'git').map((c) => c.slice(1).filter((a) => !a.startsWith('ENV ')));
    const envLines = () => fs.readFileSync(log, 'utf8').split('\n').filter((l) => l.startsWith('ENV '));
    beforeEach(() => composeFake(config('      "ports": []')));

    it.skipIf(!hasSh)('clones shallow over https, deploys the file inside the checkout, records the source; later deployments fetch and reset', () => {
      fakeGit();
      const r = parseScriptOutput(deploy(g).stdout);
      expect(r.error).toBeNull();
      expect(gitCalls()).toEqual([['clone', '--depth', '1', '--single-branch', '--branch', 'main', '--', 'https://github.com/o/r', shDir('demo') + '/repo']]);
      expect(fs.readFileSync(path.join(stackDir('demo'), 'bosun.meta'), 'utf8')).toMatch(/^source=git\nrepo=https:\/\/github.com\/o\/r\nbranch=main\nfile=deploy\/compose.yaml\nupdated=/);
      const up = dockerCalls().filter((x) => x[0] === 'compose' && x.includes('up'))[0];
      expect(up).toEqual(['compose', '-p', 'demo', '--project-directory', shDir('demo') + '/repo/deploy', '-f', shDir('demo') + '/repo/deploy/compose.yaml', 'up', '-d', '--remove-orphans']);
      expect(envLines()).toContain('ENV GIT_ALLOW_PROTOCOL=https');
      fs.writeFileSync(log, '');
      fakeGit();
      expect(parseScriptOutput(deploy(g).stdout).done).toBe('deployed demo');
      const repoDir = shDir('demo') + '/repo';
      expect(gitCalls().map((c) => c.join(' '))).toEqual([
        `-C ${repoDir} config --get remote.origin.url`, `-C ${repoDir} rev-parse HEAD`, `-C ${repoDir} fetch --depth 1 origin main`, `-C ${repoDir} reset --hard FETCH_HEAD`,
      ]);
    });

    it.skipIf(!hasSh)('the token travels only in the environment of git: never in an argument, in the output, in a file, or in docker\'s environment', () => {
      fakeGit();
      const res = deploy(g, { BOSUN_SECRET_git_token: TOKEN });
      expect(parseScriptOutput(res.stdout).done).toBe('deployed demo');
      const b64 = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
      const logText = fs.readFileSync(log, 'utf8');
      const argLines = logText.split('\n').filter((l) => l.startsWith('ARG '));
      expect(argLines.some((l) => l.includes(TOKEN) || l.includes(b64))).toBe(false);
      expect(res.stdout + res.stderr).not.toContain(TOKEN);
      expect(res.stdout + res.stderr).not.toContain(b64);
      expect(envLines()).toEqual(expect.arrayContaining([
        'ENV GIT_CONFIG_COUNT=2', 'ENV GIT_CONFIG_KEY_0=http.extraHeader', `ENV GIT_CONFIG_VALUE_0=Authorization: Basic ${b64}`,
        'ENV GIT_CONFIG_KEY_1=http.followRedirects', 'ENV GIT_CONFIG_VALUE_1=false', 'ENV SECRET=',
      ]));
      const files: string[] = [];
      const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else files.push(fs.readFileSync(p, 'utf8')); } };
      walk(home);
      expect(files.some((f) => f.includes(TOKEN) || f.includes(b64))).toBe(false);
      // the docker/compose calls do not inherit it either: the fake docker would have logged nothing, so check with an env dump
      fakeCmd('docker', 'env >> "$LOG.env"; case "$*" in *config*) cat "' + path.join(bin, 'cfg.json') + '" ;; esac; exit 0');
      deploy({ ...g }, { BOSUN_SECRET_git_token: TOKEN });
      expect(fs.readFileSync(path.join(bin, 'calls.log.env'), 'utf8')).not.toContain(TOKEN);
    });

    it.skipIf(!hasSh)('sends no authorization to hosts other than github.com, and refuses an odd token', () => {
      fakeGit();
      const res = deploy({ ...g, repo: 'https://git.example.com/o/r' }, { BOSUN_SECRET_git_token: TOKEN });
      expect(res.stdout).toMatch(/only used for github.com/);
      expect(envLines()).toContain('ENV GIT_CONFIG_COUNT=');
      expect(envLines().some((l) => l.includes('Authorization'))).toBe(false);
      expect(parseScriptOutput(deploy(g, { BOSUN_SECRET_git_token: 'a b;c' }).stdout).error).toMatch(/Git token has unexpected characters/);
    });

    it.skipIf(!hasSh)('a refused or broken git deployment removes a fresh clone, and a failing clone leaves no stack folder', () => {
      fakeGit();
      composeFake(config('      "privileged": true'));
      fakeGit();
      expect(parseScriptOutput(deploy(g).stdout).error).toMatch(/needs the permission/);
      expect(fs.existsSync(stackDir('demo'))).toBe(false);
      composeFake(config(''));
      fakeCmd('git', `echo 'fatal: repository not found' >&2; exit 128`);
      expect(parseScriptOutput(deploy(g).stdout).error).toMatch(/git clone failed: fatal: repository not found/);
      expect(fs.existsSync(stackDir('demo'))).toBe(false);
      fakeCmd('git', `case "$1" in clone) for last; do :; done; mkdir -p "$last/.git"; ;; esac; exit 0`);
      expect(parseScriptOutput(deploy(g).stdout).error).toMatch(/file deploy\/compose.yaml was not found in the repository/);
      expect(fs.existsSync(stackDir('demo'))).toBe(false);
    });

    it.skipIf(!hasSh)('a refused update of an existing checkout goes back to the previous commit', () => {
      fakeGit();
      expect(parseScriptOutput(deploy(g).stdout).error).toBeNull();
      composeFake(config('      "privileged": true'));
      fs.writeFileSync(log, '');
      fakeGit();
      expect(parseScriptOutput(deploy(g).stdout).error).toMatch(/needs the permission/);
      const repoDir = shDir('demo') + '/repo';
      expect(gitCalls().at(-1)!.join(' ')).toBe(`-C ${repoDir} reset --hard deadbeef`);
      expect(fs.existsSync(path.join(stackDir('demo'), 'repo'))).toBe(true);
    });
  });

  it.skipIf(!hasSh)('stack_action: docker compose -p with the stored files; external stacks only stop/start/restart/down', () => {
    seed('web', { 'compose.yaml': 'x', '.env': 'A=1', 'bosun.meta': 'source=editor\n' });
    seed('g', { 'repo/d/compose.yaml': 'x', 'bosun.meta': 'source=git\nfile=d/compose.yaml\n' });
    fake('exit 0');
    const web = shDir('web');
    const base = ['compose', '-p', 'web', '--project-directory', web, '-f', web + '/compose.yaml', '--env-file', web + '/.env'];
    const expected: Record<string, string[]> = { up: ['up', '-d', '--remove-orphans'], down: ['down'], restart: ['restart'], pull: ['pull'], stop: ['stop'], start: ['start'] };
    for (const [op, tail] of Object.entries(expected)) {
      fs.writeFileSync(log, '');
      expect(out('stack_action.sh', { name: 'web', op }).done, op).toBe(`${op}: web`);
      expect(dockerCalls().filter((c) => c[0] === 'compose' && c[1] === '-p')).toEqual([[...base, ...tail]]);
    }
    fs.writeFileSync(log, '');
    out('stack_action.sh', { name: 'g', op: 'restart' });
    expect(dockerCalls().filter((c) => c[1] === '-p')).toEqual([['compose', '-p', 'g', '--project-directory', shDir('g') + '/repo/d', '-f', shDir('g') + '/repo/d/compose.yaml', 'restart']]);
    fs.writeFileSync(log, '');
    expect(out('stack_action.sh', { name: 'ext', op: 'restart' }).done).toBe('restart: ext');
    expect(dockerCalls().filter((c) => c[1] === '-p')).toEqual([['compose', '-p', 'ext', 'restart']]);
    expect(out('stack_action.sh', { name: 'ext', op: 'up' }).error).toMatch(/not created by Bosun/);
    expect(out('stack_action.sh', { name: 'web', op: 'rm -rf' }).error).toMatch(/op must be/);
    expect(out('stack_action.sh', { name: 'Web', op: 'up' }).error).toMatch(/invalid stack name/);
    fake('case "$1 $2" in "compose version") exit 0 ;; esac; echo "service web: no such image" >&2; exit 1');
    expect(out('stack_action.sh', { name: 'web', op: 'start' }).error).toMatch(/docker compose start failed: service web: no such image/);
    fake('case "$1 $2" in "compose version") exit 1 ;; esac');
    expect(out('stack_action.sh', { name: 'web', op: 'start' }).error).toMatch(/is not installed/);
  });

  it.skipIf(!hasSh)('stack_remove: down (with --volumes when asked), then the folder goes; a failing down keeps it', () => {
    seed('web', { 'compose.yaml': 'x', 'bosun.meta': 'source=editor\n' });
    fake('exit 0');
    const web = stackDir('web');
    const shweb = shDir('web');
    expect(out('stack_remove.sh', { name: 'web', volumes: 'true' }).done).toBe('removed stack web');
    expect(dockerCalls().filter((c) => c[1] === '-p')).toEqual([['compose', '-p', 'web', '--project-directory', shweb, '-f', shweb + '/compose.yaml', 'down', '--remove-orphans', '--volumes']]);
    expect(fs.existsSync(web)).toBe(false);
    seed('web', { 'compose.yaml': 'x', 'bosun.meta': 'source=editor\n' });
    fs.writeFileSync(log, '');
    out('stack_remove.sh', { name: 'web', volumes: 'false' });
    expect(dockerCalls().filter((c) => c[1] === '-p')[0].slice(-2)).toEqual(['down', '--remove-orphans']);
    seed('keep', { 'compose.yaml': 'x', 'bosun.meta': 'source=editor\n' });
    fake('case "$1 $2" in "compose version") exit 0 ;; esac; echo "boom" >&2; exit 1');
    expect(out('stack_remove.sh', { name: 'keep', volumes: 'false' }).error).toMatch(/down failed: boom/);
    expect(fs.existsSync(stackDir('keep'))).toBe(true);
    expect(out('stack_remove.sh', { name: '../..', volumes: 'false' }).error).toMatch(/invalid stack name/);
  });

  describe('overrides (svc.<service>.<key>=value lines)', () => {
    /** compose answers `version --short` with `ver`, and prints `cfg` for config. */
    const ovFake = (cfg: string, ver = '2.29.1') => {
      fs.writeFileSync(path.join(bin, 'cfg.json'), cfg);
      fake(`case "$*" in "compose version --short") echo ${ver}; exit 0 ;; "compose version") echo v2; exit 0 ;; esac
case "$*" in *' config --format json'*) cat "${path.join(bin, 'cfg.json')}" ;; esac
exit 0`);
    };
    const OVERRIDE = '# the dialog\nsvc.web.container_name=shop-web\nsvc.web.port=127.0.0.1:8081:80/tcp\nsvc.web.port=9000:9000/udp\nsvc.web.volume=./data:/data\nsvc.web.volume=named:/n:ro\nsvc.web.network=backend\nsvc.db.port=\n';

    it.skipIf(!hasSh)('writes compose.override.yaml with !override tags, checks and starts with both files, and stores the lines', () => {
      ovFake(config('      "ports": []'));
      const r = parseScriptOutput(deploy({ override: OVERRIDE }).stdout);
      expect(r.error).toBeNull();
      expect(r.done).toBe('deployed demo');
      expect(r.steps).toEqual(['Reading the compose file', 'Checking the compose file', 'Storing the stack files', `Starting the stack demo`]);
      const d = stackDir('demo'); const sd = shDir('demo');
      expect(fs.readFileSync(path.join(d, 'compose.override.yaml'), 'utf8')).toBe([
        'services:', '  "web":', '    container_name: "shop-web"', '    ports: !override', '      - "127.0.0.1:8081:80/tcp"', '      - "9000:9000/udp"',
        '    volumes: !override', '      - "./data:/data"', '      - "named:/n:ro"', '    networks: !override', '      - "backend"',
        '  "db":', '    ports: !override []', '',
      ].join('\n'));
      expect(fs.readFileSync(path.join(d, 'bosun.override'), 'utf8')).toBe(OVERRIDE);
      expect(fs.readdirSync(d).sort()).toEqual(['.env', 'bosun.meta', 'bosun.override', 'compose.override.yaml', 'compose.yaml']);
      const c = dockerCalls().filter((x) => x[0] === 'compose' && x[1] === '-p');
      expect(c[0]).toEqual(['compose', '-p', 'demo', '--project-directory', sd, '-f', sd + '/compose.yaml.new', '-f', sd + '/compose.override.yaml.new', '--env-file', sd + '/.env.new', 'config', '--format', 'json']);
      expect(c[1]).toEqual(['compose', '-p', 'demo', '--project-directory', sd, '-f', sd + '/compose.yaml', '-f', sd + '/compose.override.yaml', '--env-file', sd + '/.env', 'up', '-d', '--remove-orphans']);
      // stack_get hands the lines back, stack_action keeps using the override file
      expect(JSON.parse(run('stack_get.sh', { name: 'demo' }).stdout).override).toBe(OVERRIDE);
      fs.writeFileSync(log, '');
      out('stack_action.sh', { name: 'demo', op: 'restart' });
      expect(dockerCalls().filter((x) => x[1] === '-p')).toEqual([['compose', '-p', 'demo', '--project-directory', sd, '-f', sd + '/compose.yaml', '-f', sd + '/compose.override.yaml', '--env-file', sd + '/.env', 'restart']]);
    });

    it.skipIf(!hasSh)('no override lines: no override file, and an old one is removed (also when only comments or empty container names are given)', () => {
      ovFake(config('      "ports": []'));
      deploy({ override: 'svc.web.port=8080:80' });
      expect(fs.existsSync(path.join(stackDir('demo'), 'compose.override.yaml'))).toBe(true);
      fs.writeFileSync(log, '');
      expect(parseScriptOutput(deploy({ override: '' }).stdout).done).toBe('deployed demo');
      for (const f of ['compose.override.yaml', 'bosun.override']) expect(fs.existsSync(path.join(stackDir('demo'), f)), f).toBe(false);
      const sd = shDir('demo');
      expect(dockerCalls().filter((x) => x[1] === '-p').map((x) => x.slice(5, 8).join(' '))).toEqual([`-f ${sd}/compose.yaml.new --env-file`, `-f ${sd}/compose.yaml --env-file`]);
      deploy({ override: 'svc.web.port=8080:80' });
      expect(parseScriptOutput(deploy({ override: '# nothing\n\nsvc.web.container_name=\n' }).stdout).done).toBe('deployed demo');
      expect(fs.existsSync(path.join(stackDir('demo'), 'compose.override.yaml'))).toBe(false);
      expect(JSON.parse(run('stack_get.sh', { name: 'demo' }).stdout).override).toBe('');
    });

    it.skipIf(!hasSh)('refuses lines that are not valid before anything is stored or compose is asked', () => {
      ovFake(config('      "ports": []'));
      const bad: [string, RegExp][] = [
        ['port=8080:80', /^override line 1: use svc\.<service>/], ['svc.web.port', /has no '='/], ['svc.web.ports=1:2', /use svc\./], ['svc.web.image=x', /use svc\./], ['svc..port=1:2', /use svc\./],
        ['svc.web.port=abc', /port: use \[hostip:\]hostport:containerport/], ['svc.web.port=1:2:3:4', /port: use/], ['svc.web.volume=/a', /volume: use source:target/], ['svc.web.volume=/a:rel', /target must be an absolute path/],
        ['svc.web.volume=/a:/b:zz', /mode can only be ro or rw/], ['svc.web.volume=../x:/y', /source must be a volume name/], ['svc.web.volume=./../x:/y', /\.\. is not allowed/], ['svc.web.volume=a/b:/y', /source must be a volume name/],
        ['svc.web.network=bad name', /network: invalid network name/], ['svc.web.container_name=bad name', /container_name: use letters/], ['svc.web.container_name=a\nsvc.web.container_name=b', /given twice for web/],
        ['svc.web.port=1:2$(x)', /characters that are not allowed/], ['svc.web.volume=/a:/b"', /characters that are not allowed/], ['svc.web.volume=/a\\b:/c', /characters that are not allowed/],
        ['svc.web.port=' + 'x'.repeat(1001), /longer than 1000/], [Array.from({ length: 201 }, (_, i) => `svc.s${i}.port=1:2`).join('\n'), /too many lines/],
      ];
      for (const [o, why] of bad) {
        fs.writeFileSync(log, '');
        const r = parseScriptOutput(deploy({ override: o }).stdout);
        expect(r.error ?? 'NO ERROR', o.slice(0, 50)).toMatch(why);
        expect(r.done).toBeNull();
        expect(dockerCalls().filter((x) => x[1] === '-p')).toEqual([]);
        expect(fs.existsSync(stackDir('demo')), o.slice(0, 50)).toBe(false);
      }
    });

    it.skipIf(!hasSh)('needs Docker Compose 2.24 for the !override tags, says so, and stores nothing; without overrides any version works', () => {
      for (const [ver, ok] of [['2.20.1', false], ['v2.23.9', false], ['1.29.2', false], ['2.24.0', true], ['v2.29.1', true], ['5.6.1', true], ['dev', true]] as const) {
        ovFake(config('      "ports": []'), ver);
        const r = parseScriptOutput(deploy({ override: 'svc.web.port=8080:80' }).stdout);
        if (ok) expect(r.done, ver).toBe('deployed demo'); else { expect(r.error, ver).toBe(`Overriding ports, volumes, networks or the container name needs Docker Compose 2.24 or newer (this host has ${ver.replace(/^v/, '')})`); expect(fs.existsSync(stackDir('demo')), ver).toBe(false); }
        fs.rmSync(stackDir('demo'), { recursive: true, force: true });
      }
      ovFake(config('      "ports": []'), '2.10.0');
      expect(parseScriptOutput(deploy({ override: '' }).stdout).done).toBe('deployed demo');
    });

    it.skipIf(!hasSh)('the risky check reads the MERGED configuration: a refused override keeps the stored stack as it was', () => {
      ovFake(config('      "ports": []'));
      deploy({ override: 'svc.web.port=8080:80' });
      const before = fs.readFileSync(path.join(stackDir('demo'), 'compose.override.yaml'), 'utf8');
      // the merged config (what compose prints for the two files) has a host path of /etc
      ovFake(config('      "volumes": [\n        {\n          "type": "bind",\n          "source": "/etc",\n          "target": "/x"\n        }\n      ]'));
      const r = parseScriptOutput(deploy({ override: 'svc.web.volume=/etc:/x' }).stdout);
      expect(r.error).toBe('needs the permission to use elevated container options: host path /etc');
      expect(fs.readFileSync(path.join(stackDir('demo'), 'compose.override.yaml'), 'utf8')).toBe(before);
      expect(fs.readFileSync(path.join(stackDir('demo'), 'bosun.override'), 'utf8')).toBe('svc.web.port=8080:80\n');
      expect(fs.existsSync(path.join(stackDir('demo'), 'compose.override.yaml.new'))).toBe(false);
      // with the permission it goes through
      expect(parseScriptOutput(deploy({ override: 'svc.web.volume=/etc:/x', allow_risky: 'true' }).stdout).done).toBe('deployed demo');
    });

    it.skipIf(!hasSh)('a git stack passes the override file as the second -f next to the file of the checkout', () => {
      ovFake(config('      "ports": []'));
      fakeCmd('git', `case "$*" in clone*|*' clone '*) for last; do :; done; mkdir -p "$last/.git" "$last/deploy"; printf 'services:\\n  web:\\n    image: nginx\\n' > "$last/deploy/compose.yaml" ;; esac; exit 0`);
      const r = parseScriptOutput(deploy({ source: 'git', yaml: '', env: '', repo: 'https://github.com/o/r', branch: 'main', file: 'deploy/compose.yaml', override: 'svc.web.network=backend' }).stdout);
      expect(r.error).toBeNull();
      const sd = shDir('demo');
      const up = dockerCalls().filter((x) => x[1] === '-p').at(-1)!;
      expect(up).toEqual(['compose', '-p', 'demo', '--project-directory', sd + '/repo/deploy', '-f', sd + '/repo/deploy/compose.yaml', '-f', sd + '/compose.override.yaml', 'up', '-d', '--remove-orphans']);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Round 2: logs, steps, prune, exports, convert, exposed ports, git datasets, stack overrides. Real outputs of Docker 29 on a host were
// captured for the fixtures (the facts a container prints through the template of the export scripts, `docker compose config`).
// ---------------------------------------------------------------------------------------------------------------------------------
const lines = (a: string[]) => a.join('\n') + '\n';
/** Everything a dataset prints is one JSON document. */
const json = (file: string, params: Record<string, string> = {}, extraEnv: Record<string, string> = {}) => JSON.parse(run(file, params, extraEnv).stdout);
/** A private TMPDIR, so that a test can see that the scripts remove their temporary folders. */
const privateTmp = () => { const t = path.join(bin, 'tmp'); fs.mkdirSync(t, { recursive: true }); return { TMPDIR: sp(t), dir: t }; };

describe('logs: the log of a container cannot forge the job protocol (bug 11)', () => {
  it.skipIf(!hasSh)('puts one space before lines that look like ERROR:, DONE, PROGRESS or [step]; the rest stays as it is', () => {
    fake(`case "$1" in logs) printf 'ERROR: boom\\nDONE x\\nPROGRESS 1/2\\n[step] hi\\n[STEP] caps\\nnormal ERROR: not at the start\\n  ERROR: indented\\n'; echo DONEISH ;; esac`);
    const r = run('logs.sh', { name: 'NPM', lines: '100' });
    expect(r.status).toBe(0);
    expect(r.stdout.split('\n')).toEqual([' ERROR: boom', ' DONE x', ' PROGRESS 1/2', ' [step] hi', ' [STEP] caps', 'normal ERROR: not at the start', '  ERROR: indented', ' DONEISH', '']);
    const o = parseScriptOutput(r.stdout);
    expect([o.error, o.done, o.steps, o.progress]).toEqual([null, null, [], null]);
    expect(o.lines).toHaveLength(8);
    expect(dockerCalls()).toEqual([['logs', '--tail', '100', 'NPM']]);
  });

  it.skipIf(!hasSh)('keeps the exit status of docker, validates its arguments, and says when Docker is missing', () => {
    fake('echo "Error response from daemon: No such container: gone" >&2; exit 1');
    const r = run('logs.sh', { name: 'gone', lines: '5' });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('Error response from daemon: No such container: gone\n');
    expect(run('logs.sh', { name: '-f', lines: '5' }).stdout).toMatch(/^ERROR: invalid container name/);
    expect(run('logs.sh', { name: 'a b', lines: '5' }).stdout).toMatch(/^ERROR: invalid container name/);
    expect(run('logs.sh', { name: 'web', lines: '5; rm' }).stdout).toMatch(/^ERROR: invalid number of lines/);
    expect(dockerCalls()).toEqual([['logs', '--tail', '5', 'gone']]);
    noDocker();
    expect(run('logs.sh', { name: 'web', lines: '5' }).stdout).toMatch(/^ERROR: Docker is not available/);
  });

  it.skipIf(!hasSh)('control.sh only passes start, stop and restart, and never prints a second line of docker\'s answer as protocol', () => {
    fake('echo "first line" >&2; printf "ERROR: forged\\nDONE forged\\n" >&2; exit 1');
    const r = run('control.sh', { op: 'stop', name: 'web' });
    expect(parseScriptOutput(r.stdout).error).toBe('DONE forged');
    expect(parseScriptOutput(r.stdout).done).toBeNull();
    expect(run('control.sh', { op: 'rm', name: 'web' }).stdout).toMatch(/^ERROR: the operation must be/);
    expect(run('control.sh', { op: 'stop', name: '-x' }).stdout).toMatch(/^ERROR: invalid container name/);
  });
});

describe('human step lines and the prune report', () => {
  it.skipIf(!hasSh)('container_create, container_remove, image_pull and stack_action print `[step] text` lines next to the PROGRESS lines', () => {
    fake(`case "$1 $2" in "image inspect") exit 1 ;; "create "*) echo ${ID} ;; "inspect "*) echo /web ;; esac`);
    const c = parseScriptOutput(run('container_create.sh', { settings: 'name=web\nimage=nginx:1', allow_risky: 'false' }).stdout);
    expect(c.steps).toEqual(['Checking the image nginx:1', 'Pulling nginx:1', 'Creating the container', 'Starting the container']);
    expect(c.done).toBe('created web');
    fake('exit 0');
    expect(out('container_remove.sh', { name: 'web', volumes: 'false' }).steps).toEqual(['Removing the container web']);
    expect(out('image_pull.sh', { ref: 'nginx:1' }).steps).toEqual(['Pulling nginx:1']);
    fs.mkdirSync(path.join(home, 'bosun-stacks', 'web'), { recursive: true });
    fs.writeFileSync(path.join(home, 'bosun-stacks', 'web', 'compose.yaml'), 'x');
    expect(out('stack_action.sh', { name: 'web', op: 'restart' }).steps).toEqual(['Running docker compose restart for the stack web']);
    expect(out('stack_remove.sh', { name: 'web', volumes: 'false' }).steps).toEqual(['Taking the stack web down', 'Deleting the stored stack files']);
  });

  it.skipIf(!hasSh)('image_prune says how many images went and how much space came back (the images before and after are compared)', () => {
    const state = path.join(bin, 'ls.count');
    fs.writeFileSync(state, '0');
    const A = 'sha256:' + 'a'.repeat(64); const B = 'sha256:' + 'b'.repeat(64); const C = 'sha256:' + 'c'.repeat(64); const E = 'sha256:' + 'e'.repeat(64);
    fake(`case "$1 $2" in
  "image ls") n=$(cat "${sp(state)}"); echo $((n + 1)) > "${sp(state)}"; if [ $n -eq 0 ]; then printf '${A}\\n${B}\\n${C}\\n${E}\\n'; else printf '${E}\\n'; fi ;;
  "image prune") printf 'Deleted Images:\\nuntagged: x:1\\ndeleted: ${A}\\ndeleted: layer\\nTotal reclaimed space: 1.2GB\\n' ;;
esac`);
    const r = parseScriptOutput(run('image_prune.sh', { all: 'true' }).stdout);
    expect(r.done).toBe('removed 3 images, reclaimed 1.2GB');
    expect(r.steps).toEqual(['Removing every image no container uses']);
    expect(dockerCalls().map((c) => c.join(' '))).toEqual(['image ls -a -q --no-trunc', 'image prune -f -a', 'image ls -a -q --no-trunc']);
    fs.writeFileSync(state, '0');
    fake(`case "$1 $2" in
  "image ls") n=$(cat "${sp(state)}"); echo $((n + 1)) > "${sp(state)}"; if [ $n -eq 0 ]; then printf '${A}\\n${E}\\n'; else printf '${E}\\n'; fi ;;
  "image prune") printf 'Deleted Images:\\ndeleted: ${A}\\nTotal reclaimed space: 5.5MB\\n' ;;
esac`);
    expect(out('image_prune.sh', { all: 'false' }).done).toBe('removed 1 image, reclaimed 5.5MB');
    fake('case "$1 $2" in "image prune") echo "Total reclaimed space: 0B" ;; esac');
    expect(out('image_prune.sh', { all: 'false' }).done).toBe('removed 0 images, reclaimed 0B');
    fake('case "$1 $2" in "image prune") echo "Error response from daemon: a prune operation is already running" >&2; exit 1 ;; esac');
    expect(out('image_prune.sh', { all: 'false' }).error).toMatch(/already running/);
  });
});

describe('export_run and export_compose (datasets)', () => {
  const FACTS = lines([
    "ID \"5d3d146bc88fe37079c9fe4bc1cfdad948e888e44f1d22715df2b7264259155c\"",
    "NAME \"/bsbt-web\"",
    "IMAGE \"alpine:3.20\"",
    "IMGID sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc",
    "ENV \"A=1\"",
    "ENV \"B=a b $x \\\"q\\\" it's\"",
    "ENV \"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\"",
    "CMDJ [\"-c\",\"sleep 600\"]",
    "EPJ [\"sh\"]",
    "CMD \"-c\"",
    "CMD \"sleep 600\"",
    "EP \"sh\"",
    "LABEL \"my.label=x y\"",
    "PORT \"\" \"18443\" \"443/tcp\"",
    "PORT \"127.0.0.1\" \"18080\" \"80/tcp\"",
    "MNT \"volume\" \"667410d46cf6114b6e58d63aa0bbabcbc2c2411c1d2db0987e425db81107109a\" \"/var/lib/docker/volumes/667410d46cf6114b6e58d63aa0bbabcbc2c2411c1d2db0987e425db81107109a/_data\" \"/anonvol\" true",
    "MNT \"bind\" null \"/tmp/bsbt-bind\" \"/bind\" false",
    "MNT \"volume\" \"bsbt-vol\" \"/var/lib/docker/volumes/bsbt-vol/_data\" \"/data\" true",
    "TMPFS \"/run:size=10m\"",
    "NETMODE \"bsbt-net\"",
    "NETN \"bsbt-net\"",
    "ALIAS \"bsbt-net\" \"w1\"",
    "RP \"on-failure\"",
    "RPN 3",
    "HOSTNAME \"bsbthost\"",
    "USER \"1000:1000\"",
    "WORKDIR \"/tmp\"",
    "MEM 268435456",
    "NANO 500000000",
    "DNS \"1.1.1.1\"",
    "EXTRAHOST \"h:10.0.0.9\"",
    "LOGT \"json-file\"",
    "LOGO \"max-size=1m\"",
    "STOPSIG \"SIGINT\"",
    "STOPTO 7",
    "TTY true",
    "OPEN true",
    "INIT true",
    "RO true",
    "HEALTHJ {\"Interval\":30000000000,\"Test\":[\"CMD-SHELL\",\"true\"]}",
    "HKIND \"CMD-SHELL\"",
    "HARG \"true\"",
    "HINT 30000000000",
    "HTO <no value>",
    "HRET <no value>",
    "HSTART <no value>",
    "PRIV false",
    "PIDM \"\"",
    "IPCM \"private\"",
    "CAPADD \"CAP_NET_ADMIN\"",
    "CAPDROP \"CAP_MKNOD\"",
    "SECOPT \"no-new-privileges\"",
    "SYSCTL \"net.ipv4.ip_unprivileged_port_start=0\"",
    "ULIM \"nofile\" 1024 2048",
    "SHM 134217728",
    "OOM 0",
    "CGP \"\"",
    "RT \"runc\"",
    "CPUSET \"\"",
    "CPUSHARES 0",
    "PIDSLIM <no value>",
    "MEMRES 0",
    "UTS \"\"",
    "USERNS \"\"",
  ]);
  const IFACTS = lines([
    "ENV \"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\"",
    "CMDJ [\"/bin/sh\"]",
    "EPJ null",
    "USER null",
    "WORKDIR \"/\"",
    "STOPSIG null",
    "HEALTHJ null",
  ]);
  const exportFake = (opts: { facts?: string; ifacts?: string; vols?: string[]; nets?: string[] } = {}) => {
    fs.writeFileSync(path.join(bin, 'facts.txt'), opts.facts ?? FACTS);
    fs.writeFileSync(path.join(bin, 'ifacts.txt'), opts.ifacts ?? IFACTS);
    fake(`case "$1 $2" in
  "inspect --type") cat "${sp(path.join(bin, 'facts.txt'))}" ;;
  "image inspect") cat "${sp(path.join(bin, 'ifacts.txt'))}" ;;
  "volume ls") printf '%s\\n' ${(opts.vols ?? ['bsbt-vol']).map((v) => `'${v}'`).join(' ')} ;;
  "network ls") printf '%s\\n' ${(opts.nets ?? ['bridge', 'bsbt-net']).map((v) => `'${v}'`).join(' ')} ;;
esac`);
  };
  const text = (file: string, name = 'bsbt-web') => { const j = json(file, { name }); expect(Object.keys(j)).toEqual(['text']); return j.text as string; };
  const WEB_ARGS = ['run', '-d', '--name', 'bsbt-web', '--restart', 'on-failure:3', '--hostname', 'bsbthost', '--user', '1000:1000', '--workdir', '/tmp', '--network', 'bsbt-net', '--network-alias', 'w1',
    '-p', '18443:443', '-p', '127.0.0.1:18080:80', '-v', '/anonvol', '-v', '/tmp/bsbt-bind:/bind:ro', '-v', 'bsbt-vol:/data', '--tmpfs', '/run:size=10m', '-e', 'A=1', '-e', 'B=a b $x "q" it\'s',
    '--label', 'my.label=x y', '--memory', '256m', '--cpus', '0.5', '--shm-size', '134217728', '--ulimit', 'nofile=1024:2048', '--dns', '1.1.1.1', '--add-host', 'h:10.0.0.9',
    '--log-driver', 'json-file', '--log-opt', 'max-size=1m', '--stop-signal', 'SIGINT', '--stop-timeout', '7', '-t', '-i', '--init', '--read-only', '--health-cmd', 'true', '--health-interval', '30s',
    '--cap-add', 'NET_ADMIN', '--cap-drop', 'MKNOD', '--security-opt', 'no-new-privileges', '--sysctl', 'net.ipv4.ip_unprivileged_port_start=0', '--entrypoint', 'sh', 'alpine:3.20', '-c', 'sleep 600'];

  it.skipIf(!hasSh)('the collector and the reader are the very same text in both scripts', () => {
    const block = (f: string, name: string) => new RegExp(`# >>> export ${name}[\\s\\S]*# <<< export ${name}`).exec(script(f))![0];
    for (const name of ['collector', 'reader']) {
      expect(block('export_run.sh', name)).toBe(block('export_compose.sh', name));
      expect(block('export_run.sh', name).length).toBeGreaterThan(1500);
    }
  });

  it.skipIf(!hasSh)('export_run: a docker run -d command, one option per line with \\ continuations, what the image provides left out', () => {
    exportFake();
    expect(text('export_run.sh')).toBe(lines([
    "docker run -d \\",
    "  --name bsbt-web \\",
    "  --restart on-failure:3 \\",
    "  --hostname bsbthost \\",
    "  --user 1000:1000 \\",
    "  --workdir /tmp \\",
    "  --network bsbt-net \\",
    "  --network-alias w1 \\",
    "  -p 18443:443 \\",
    "  -p 127.0.0.1:18080:80 \\",
    "  -v /anonvol \\",
    "  -v /tmp/bsbt-bind:/bind:ro \\",
    "  -v bsbt-vol:/data \\",
    "  --tmpfs /run:size=10m \\",
    "  -e A=1 \\",
    "  -e 'B=a b $x \"q\" it'\\''s' \\",
    "  --label 'my.label=x y' \\",
    "  --memory 256m \\",
    "  --cpus 0.5 \\",
    "  --shm-size 134217728 \\",
    "  --ulimit nofile=1024:2048 \\",
    "  --dns 1.1.1.1 \\",
    "  --add-host h:10.0.0.9 \\",
    "  --log-driver json-file \\",
    "  --log-opt max-size=1m \\",
    "  --stop-signal SIGINT \\",
    "  --stop-timeout 7 \\",
    "  -t \\",
    "  -i \\",
    "  --init \\",
    "  --read-only \\",
    "  --health-cmd true \\",
    "  --health-interval 30s \\",
    "  --cap-add NET_ADMIN \\",
    "  --cap-drop MKNOD \\",
    "  --security-opt no-new-privileges \\",
    "  --sysctl net.ipv4.ip_unprivileged_port_start=0 \\",
    "  --entrypoint sh \\",
    "  alpine:3.20 \\",
    "  -c 'sleep 600'",
  ]));
  });

  it.skipIf(!hasSh)('export_run: the command, run by a shell, hands docker exactly the arguments of the container (quotes, $ and ` stay data)', () => {
    const evil = '$(touch pwned) `touch pwned2` "q" \'s\' \\ ;|&  tab\there';
    exportFake({ facts: FACTS.replace('ENV "A=1"', 'ENV ' + JSON.stringify('A=' + evil)) });
    const t = text('export_run.sh');
    fake('exit 0');
    fs.writeFileSync(log, '');
    const r = spawnSync('sh', ['-c', t], { encoding: 'utf8', cwd: bin, env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, LOG: log } });
    expect(r.status).toBe(0);
    const args = [...WEB_ARGS]; args[args.indexOf('A=1')] = 'A=' + evil;
    expect(dockerCalls()).toEqual([args]);
    expect(fs.existsSync(path.join(bin, 'pwned'))).toBe(false);
    expect(fs.existsSync(path.join(bin, 'pwned2'))).toBe(false);
  });

  it.skipIf(!hasSh)('export_run: host network, privileged, no health check; export_run of a container on two networks with a static address lists the second one in a comment', () => {
    exportFake({ facts: lines([
    "ID \"ff27fc30748feb9bf165e2a60926c42264dfe2b75cdc0fe4595e5ae1609b9cc4\"",
    "NAME \"/bsbt-exp2\"",
    "IMAGE \"alpine:3.20\"",
    "IMGID sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc",
    "ENV \"X=$(touch /tmp/pwn) `id`\"",
    "ENV \"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\"",
    "CMDJ [\"sleep\",\"5\"]",
    "EPJ null",
    "CMD \"sleep\"",
    "CMD \"5\"",
    "LABEL \"a=b\"",
    "NETMODE \"host\"",
    "NETN \"host\"",
    "RP \"no\"",
    "RPN 0",
    "HOSTNAME \"ai-nuc\"",
    "USER \"\"",
    "WORKDIR \"/\"",
    "MEM 0",
    "NANO 0",
    "LOGT \"json-file\"",
    "STOPSIG null",
    "STOPTO <no value>",
    "TTY false",
    "OPEN false",
    "INIT <no value>",
    "RO false",
    "HEALTHJ {\"Test\":[\"NONE\"]}",
    "HKIND \"NONE\"",
    "HINT <no value>",
    "HTO <no value>",
    "HRET <no value>",
    "HSTART <no value>",
    "PRIV true",
    "PIDM \"host\"",
    "IPCM \"host\"",
    "SECOPT \"label=disable\"",
    "SHM 67108864",
    "OOM 0",
    "CGP \"\"",
    "RT \"runc\"",
    "CPUSET \"\"",
    "CPUSHARES 0",
    "PIDSLIM <no value>",
    "MEMRES 0",
    "UTS \"\"",
    "USERNS \"\"",
  ]) });
    expect(text('export_run.sh', 'bsbt-exp2')).toBe(lines([
    "docker run -d \\",
    "  --name bsbt-exp2 \\",
    "  --network host \\",
    "  -e 'X=$(touch /tmp/pwn) `id`' \\",
    "  --label a=b \\",
    "  --no-healthcheck \\",
    "  --privileged \\",
    "  --pid host \\",
    "  --ipc host \\",
    "  --security-opt label=disable \\",
    "  alpine:3.20 \\",
    "  sleep 5",
  ]));
    exportFake({ facts: lines([
    "ID \"970a37d907fde9e6192be0f9b11be1b92d7ed3cfba149734a271745928880d93\"",
    "NAME \"/bsbt-exp3\"",
    "IMAGE \"alpine:3.20\"",
    "IMGID sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc",
    "ENV \"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\"",
    "CMDJ [\"/bin/sh\"]",
    "EPJ null",
    "CMD \"/bin/sh\"",
    "NETMODE \"bsbt-net2\"",
    "NETN \"bsbt-net\"",
    "NETN \"bsbt-net2\"",
    "ALIAS \"bsbt-net2\" \"a1\"",
    "IP4 \"bsbt-net2\" \"10.253.77.5\"",
    "RP \"no\"",
    "RPN 0",
    "HOSTNAME \"970a37d907fd\"",
    "USER \"\"",
    "WORKDIR \"/\"",
    "MEM 0",
    "NANO 0",
    "LOGT \"local\"",
    "STOPSIG null",
    "STOPTO <no value>",
    "TTY false",
    "OPEN false",
    "INIT <no value>",
    "RO false",
    "HEALTHJ {\"Retries\":4,\"StartPeriod\":1000000000,\"Test\":[\"CMD-SHELL\",\"CMD-ignore\"],\"Timeout\":2000000000}",
    "HKIND \"CMD-SHELL\"",
    "HARG \"CMD-ignore\"",
    "HINT <no value>",
    "HTO 2000000000",
    "HRET 4",
    "HSTART 1000000000",
    "PRIV false",
    "PIDM \"\"",
    "IPCM \"private\"",
    "DEVICE \"/dev/null:/dev/nn:rw\"",
    "DCR \"c 1:3 rmw\"",
    "GRP \"5\"",
    "SHM 67108864",
    "OOM 100",
    "CGP \"\"",
    "RT \"runc\"",
    "CPUSET \"\"",
    "DNSS \"foo.local\"",
    "DNSO \"ndots:2\"",
    "CPUSHARES 512",
    "PIDSLIM 50",
    "MEMRES 67108864",
    "UTS \"host\"",
    "USERNS \"\"",
  ]) });
    expect(text('export_run.sh', 'bsbt-exp3')).toBe(lines([
    "docker run -d \\",
    "  --name bsbt-exp3 \\",
    "  --network bsbt-net2 \\",
    "  --network-alias a1 \\",
    "  --ip 10.253.77.5 \\",
    "  --memory-reservation 67108864 \\",
    "  --cpu-shares 512 \\",
    "  --pids-limit 50 \\",
    "  --oom-score-adj 100 \\",
    "  --group-add 5 \\",
    "  --dns-search foo.local \\",
    "  --dns-option ndots:2 \\",
    "  --log-driver local \\",
    "  --health-cmd CMD-ignore \\",
    "  --health-timeout 2s \\",
    "  --health-retries 4 \\",
    "  --health-start-period 1s \\",
    "  --uts host \\",
    "  --device /dev/null:/dev/nn:rw \\",
    "  --device-cgroup-rule 'c 1:3 rmw' \\",
    "  alpine:3.20",
    "# Also attached to the networks: bsbt-net (docker network connect <network> bsbt-exp3)",
  ]));
  });

  it.skipIf(!hasSh)('export_compose: one service, named volumes and networks declared external when they exist, $ doubled', () => {
    exportFake();
    expect(text('export_compose.sh')).toBe(lines([
    "services:",
    "  bsbt-web:",
    "    image: \"alpine:3.20\"",
    "    container_name: \"bsbt-web\"",
    "    restart: \"on-failure:3\"",
    "    hostname: \"bsbthost\"",
    "    user: \"1000:1000\"",
    "    working_dir: \"/tmp\"",
    "    entrypoint: [\"sh\"]",
    "    command: [\"-c\", \"sleep 600\"]",
    "    ports:",
    "      - \"18443:443\"",
    "      - \"127.0.0.1:18080:80\"",
    "    volumes:",
    "      - \"/anonvol\"",
    "      - \"/tmp/bsbt-bind:/bind:ro\"",
    "      - \"bsbt-vol:/data\"",
    "    tmpfs:",
    "      - \"/run:size=10m\"",
    "    environment:",
    "      - \"A=1\"",
    "      - \"B=a b $$x \\\"q\\\" it's\"",
    "    labels:",
    "      - \"my.label=x y\"",
    "    networks:",
    "      bsbt-net:",
    "        aliases:",
    "          - \"w1\"",
    "    mem_limit: \"256m\"",
    "    cpus: 0.5",
    "    shm_size: \"134217728b\"",
    "    ulimits:",
    "      nofile:",
    "        soft: 1024",
    "        hard: 2048",
    "    dns:",
    "      - \"1.1.1.1\"",
    "    extra_hosts:",
    "      - \"h:10.0.0.9\"",
    "    logging:",
    "      driver: \"json-file\"",
    "      options:",
    "        \"max-size\": \"1m\"",
    "    stop_signal: \"SIGINT\"",
    "    stop_grace_period: \"7s\"",
    "    tty: true",
    "    stdin_open: true",
    "    init: true",
    "    read_only: true",
    "    healthcheck:",
    "      test: [\"CMD-SHELL\", \"true\"]",
    "      interval: \"30s\"",
    "    cap_add:",
    "      - \"NET_ADMIN\"",
    "    cap_drop:",
    "      - \"MKNOD\"",
    "    security_opt:",
    "      - \"no-new-privileges\"",
    "    sysctls:",
    "      - \"net.ipv4.ip_unprivileged_port_start=0\"",
    "volumes:",
    "  bsbt-vol:",
    "    external: true",
    "networks:",
    "  bsbt-net:",
    "    external: true",
  ]));
    // a volume or network that does not exist on the host is declared plain
    exportFake({ vols: [], nets: ['bridge'] });
    const t = text('export_compose.sh');
    expect(t).toContain('volumes:\n  bsbt-vol: {}\n');
    expect(t).toContain('networks:\n  bsbt-net: {}\n');
    expect(t).not.toContain('external');
  });

  it.skipIf(!hasSh)('export_compose: host network, privileged, a second network with a static address, health check arguments, comment for what compose cannot carry', () => {
    exportFake({ facts: lines([
    "ID \"ff27fc30748feb9bf165e2a60926c42264dfe2b75cdc0fe4595e5ae1609b9cc4\"",
    "NAME \"/bsbt-exp2\"",
    "IMAGE \"alpine:3.20\"",
    "IMGID sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc",
    "ENV \"X=$(touch /tmp/pwn) `id`\"",
    "ENV \"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\"",
    "CMDJ [\"sleep\",\"5\"]",
    "EPJ null",
    "CMD \"sleep\"",
    "CMD \"5\"",
    "LABEL \"a=b\"",
    "NETMODE \"host\"",
    "NETN \"host\"",
    "RP \"no\"",
    "RPN 0",
    "HOSTNAME \"ai-nuc\"",
    "USER \"\"",
    "WORKDIR \"/\"",
    "MEM 0",
    "NANO 0",
    "LOGT \"json-file\"",
    "STOPSIG null",
    "STOPTO <no value>",
    "TTY false",
    "OPEN false",
    "INIT <no value>",
    "RO false",
    "HEALTHJ {\"Test\":[\"NONE\"]}",
    "HKIND \"NONE\"",
    "HINT <no value>",
    "HTO <no value>",
    "HRET <no value>",
    "HSTART <no value>",
    "PRIV true",
    "PIDM \"host\"",
    "IPCM \"host\"",
    "SECOPT \"label=disable\"",
    "SHM 67108864",
    "OOM 0",
    "CGP \"\"",
    "RT \"runc\"",
    "CPUSET \"\"",
    "CPUSHARES 0",
    "PIDSLIM <no value>",
    "MEMRES 0",
    "UTS \"\"",
    "USERNS \"\"",
  ]) });
    expect(text('export_compose.sh', 'bsbt-exp2')).toBe(lines([
    "services:",
    "  bsbt-exp2:",
    "    image: \"alpine:3.20\"",
    "    container_name: \"bsbt-exp2\"",
    "    command: [\"sleep\", \"5\"]",
    "    environment:",
    "      - \"X=$$(touch /tmp/pwn) `id`\"",
    "    labels:",
    "      - \"a=b\"",
    "    network_mode: \"host\"",
    "    healthcheck:",
    "      disable: true",
    "    privileged: true",
    "    pid: \"host\"",
    "    ipc: \"host\"",
    "    security_opt:",
    "      - \"label=disable\"",
  ]));
    exportFake({ facts: lines([
    "ID \"970a37d907fde9e6192be0f9b11be1b92d7ed3cfba149734a271745928880d93\"",
    "NAME \"/bsbt-exp3\"",
    "IMAGE \"alpine:3.20\"",
    "IMGID sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc",
    "ENV \"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\"",
    "CMDJ [\"/bin/sh\"]",
    "EPJ null",
    "CMD \"/bin/sh\"",
    "NETMODE \"bsbt-net2\"",
    "NETN \"bsbt-net\"",
    "NETN \"bsbt-net2\"",
    "ALIAS \"bsbt-net2\" \"a1\"",
    "IP4 \"bsbt-net2\" \"10.253.77.5\"",
    "RP \"no\"",
    "RPN 0",
    "HOSTNAME \"970a37d907fd\"",
    "USER \"\"",
    "WORKDIR \"/\"",
    "MEM 0",
    "NANO 0",
    "LOGT \"local\"",
    "STOPSIG null",
    "STOPTO <no value>",
    "TTY false",
    "OPEN false",
    "INIT <no value>",
    "RO false",
    "HEALTHJ {\"Retries\":4,\"StartPeriod\":1000000000,\"Test\":[\"CMD-SHELL\",\"CMD-ignore\"],\"Timeout\":2000000000}",
    "HKIND \"CMD-SHELL\"",
    "HARG \"CMD-ignore\"",
    "HINT <no value>",
    "HTO 2000000000",
    "HRET 4",
    "HSTART 1000000000",
    "PRIV false",
    "PIDM \"\"",
    "IPCM \"private\"",
    "DEVICE \"/dev/null:/dev/nn:rw\"",
    "DCR \"c 1:3 rmw\"",
    "GRP \"5\"",
    "SHM 67108864",
    "OOM 100",
    "CGP \"\"",
    "RT \"runc\"",
    "CPUSET \"\"",
    "DNSS \"foo.local\"",
    "DNSO \"ndots:2\"",
    "CPUSHARES 512",
    "PIDSLIM 50",
    "MEMRES 67108864",
    "UTS \"host\"",
    "USERNS \"\"",
  ]), nets: ['bridge', 'bsbt-net', 'bsbt-net2'] });
    expect(text('export_compose.sh', 'bsbt-exp3')).toBe(lines([
    "services:",
    "  bsbt-exp3:",
    "    image: \"alpine:3.20\"",
    "    container_name: \"bsbt-exp3\"",
    "    networks:",
    "      bsbt-net2:",
    "        aliases:",
    "          - \"a1\"",
    "        ipv4_address: \"10.253.77.5\"",
    "      bsbt-net: {}",
    "    mem_reservation: \"67108864b\"",
    "    cpu_shares: 512",
    "    pids_limit: 50",
    "    oom_score_adj: 100",
    "    group_add:",
    "      - \"5\"",
    "    dns_search:",
    "      - \"foo.local\"",
    "    dns_opt:",
    "      - \"ndots:2\"",
    "    logging:",
    "      driver: \"local\"",
    "    healthcheck:",
    "      test: [\"CMD-SHELL\", \"CMD-ignore\"]",
    "      timeout: \"2s\"",
    "      retries: 4",
    "      start_period: \"1s\"",
    "    uts: \"host\"",
    "    devices:",
    "      - \"/dev/null:/dev/nn:rw\"",
    "    device_cgroup_rules:",
    "      - \"c 1:3 rmw\"",
    "networks:",
    "  bsbt-net2:",
    "    external: true",
    "  bsbt-net:",
    "    external: true",
  ]));
    exportFake({ facts: FACTS.replace('NETMODE "bsbt-net"', 'NETMODE "bsbt-net"\nLABEL "com.docker.compose.project=shop"').replace('LABEL "my.label=x y"', 'LABEL "com.docker.compose.service=web"\nLABEL "my.label=x y"').replace('RP "on-failure"', 'LINK "/db:/web/db"\nRP "on-failure"') });
    const t = text('export_compose.sh');
    expect(t.split('\n')[0]).toBe('# Not exported: links (/db:/web/db); the compose labels com.docker.compose.*');
    expect(t.split('\n').slice(1).join('\n')).not.toContain('com.docker.compose');
  });

  it.skipIf(!hasSh)('a failing inspect, an odd name, a missing Docker: ERROR with exit 0, nothing else on stdout', () => {
    fake('case "$1 $2" in "inspect --type") exit 1 ;; esac');
    for (const f of ['export_run.sh', 'export_compose.sh']) {
      const r = run(f, { name: 'ghost' });
      expect([r.status, r.stdout]).toEqual([0, 'ERROR: container ghost not found or could not be inspected\n']);
      expect(run(f, { name: '$(x)' }).stdout).toMatch(/^ERROR: invalid container name/);
      noDocker();
      expect(run(f, { name: 'web' }).stdout).toMatch(/^ERROR: Docker is not available/);
      fake('case "$1 $2" in "inspect --type") exit 1 ;; esac');
    }
  });

  it.skipIf(!hasSh)('the temporary folder is removed, and the image defaults are applied only when the image is known', () => {
    const t = privateTmp();
    exportFake();
    run('export_run.sh', { name: 'bsbt-web' }, { TMPDIR: t.TMPDIR });
    run('export_compose.sh', { name: 'bsbt-web' }, { TMPDIR: t.TMPDIR });
    expect(fs.readdirSync(t.dir)).toEqual([]);
    // without the image's own data the environment of the image (PATH) is part of the container's
    exportFake({ ifacts: '' });
    expect(text('export_run.sh')).toContain('-e PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin');
  });
});

describe('convert (dataset)', () => {
  type Conv = { fill: Record<string, string | string[]>; errors: string[]; notes: string[] };
  const conv = (input: string, extraEnv: Record<string, string> = {}) => json('convert.sh', { input }, extraEnv) as Conv;
  const KEYS = ['name', 'image', 'cmd', 'entrypoint', 'env', 'port', 'volume', 'tmpfs', 'label', 'network', 'network_alias', 'restart', 'hostname', 'user', 'workdir', 'memory', 'cpus', 'dns', 'add_host', 'log_driver', 'log_opt',
    'stop_signal', 'stop_timeout', 'tty', 'interactive', 'init', 'read_only', 'health_cmd', 'health_interval', 'health_timeout', 'health_retries', 'privileged', 'pid', 'ipc', 'cap_add', 'cap_drop', 'device', 'security_opt', 'sysctl', 'gpus'];
  /** What a person's dialog would send: the fill object as a settings blob. */
  const blob = (fill: Conv['fill']) => Object.entries(fill).flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map((x) => `${k}=${x}`)).join('\n');
  const created = (c: Conv) => { fake(`case "$1 $2" in create*) echo ${ID} ;; "inspect --format") echo /x ;; esac`); return out('container_create.sh', { settings: blob(c.fill), allow_risky: 'true' }); };

  it.skipIf(!hasSh)('the typical command', () => {
    const c = conv('docker run -d --name web -p 8080:80 -v /srv/a:/data:ro -e A=1 --restart unless-stopped nginx:alpine');
    expect(c).toEqual({ fill: { name: 'web', image: 'nginx:alpine', env: ['A=1'], port: ['8080:80'], volume: ['/srv/a:/data:ro'], restart: 'unless-stopped' }, errors: [], notes: [] });
    expect(created(c).error).toBeNull();
  });

  it.skipIf(!hasSh)('a multi-line command: continuations, quotes of both kinds, --flag=value, combined short flags, comments, the command arguments after the image', () => {
    const text = String.raw`sudo docker run -dit --rm --name=app \
  -p 127.0.0.1:8443:443/tcp -p 53:53/udp \
  -v "/srv/my data:/data" -v named:/n:ro \
  -e "GREETING=hello world" -e 'Q=it'"'"'s $HOME' -e P="a\$b \"q\"" \
  --memory 512m --cpus=1.5 \
  --health-cmd "curl -f http://localhost/ || exit 1" --health-interval 1m30s \
  --network mynet --network-alias a1 \
  --mount type=bind,source=/srv/x,target=/x,readonly --tmpfs /run:size=1m \
  myorg/img:1.2 --flag "x y" arg2 # trailing comment
`;
    const c = conv(text);
    expect(c.fill).toEqual({
      name: 'app', image: 'myorg/img:1.2', cmd: ['--flag', 'x y', 'arg2'], env: ['GREETING=hello world', 'Q=it\'s $HOME', 'P=a$b "q"'], port: ['127.0.0.1:8443:443/tcp', '53:53/udp'],
      volume: ['/srv/my data:/data', 'named:/n:ro', '/srv/x:/x:ro'], tmpfs: ['/run:size=1m'], network: 'mynet', network_alias: ['a1'], memory: '512m', cpus: '1.5', tty: 'true', interactive: 'true',
      health_cmd: 'curl -f http://localhost/ || exit 1', health_interval: '90s',
    });
    expect(c.errors).toEqual([]);
    expect(c.notes).toEqual(['--rm was ignored: the container is created normally and is not removed when it stops']);
    expect(created(c).error).toBeNull();
    const cr = conv('docker create ^\r\n  --name=w ^\r\n  -p8080:80 -hhost -ual nginx');   // cmd.exe continuations and CRLF
    expect(cr.fill).toEqual({ name: 'w', image: 'nginx', port: ['8080:80'], hostname: 'host', user: 'al' });
  });

  it.skipIf(!hasSh)('every option of the table converts to its key, and nothing but the keys of the table ever shows up', () => {
    const c = conv([
      'docker run -d --name n --hostname h -u 1:2 -w /w -m 1g --cpus 2 --dns 1.1.1.1 --dns 8.8.8.8 --add-host a:1.2.3.4 --add-host b=5.6.7.8 --log-driver json-file --log-opt max-size=1m --log-opt max-file=3',
      "--stop-signal SIGINT --stop-timeout 20 -t -i --init --read-only --privileged --health-cmd 'true' --health-interval 30s --health-timeout 5s --health-retries 3 --pid host --ipc host --cap-add NET_ADMIN --cap-drop ALL",
      "--device /dev/null:/dev/x --security-opt seccomp=unconfined --sysctl net.ipv4.ip_forward=1 --tmpfs /t --gpus all -l a.b=c -l bare --restart on-failure:3 --network-alias x --network host --entrypoint /bin/sh -e K=v=w -p 80 -p 127.0.0.1::81 -p '[::1]:82:83/udp' img a b",
    ].join(' \\\n  '));
    expect(c.errors).toEqual([]);
    expect(Object.keys(c.fill).every((k) => KEYS.includes(k))).toBe(true);
    expect(c.fill).toEqual({
      name: 'n', image: 'img', cmd: ['a', 'b'], entrypoint: ['/bin/sh'], env: ['K=v=w'], port: ['80', '127.0.0.1::81', '[::1]:82:83/udp'], tmpfs: ['/t'], label: ['a.b=c', 'bare='], network: 'host', network_alias: ['x'], restart: 'on-failure:3',
      hostname: 'h', user: '1:2', workdir: '/w', memory: '1g', cpus: '2', dns: ['1.1.1.1', '8.8.8.8'], add_host: ['a:1.2.3.4', 'b:5.6.7.8'], log_driver: 'json-file', log_opt: ['max-size=1m', 'max-file=3'], stop_signal: 'SIGINT', stop_timeout: '20',
      tty: 'true', interactive: 'true', init: 'true', read_only: 'true', health_cmd: 'true', health_interval: '30s', health_timeout: '5s', health_retries: '3', privileged: 'true', pid: 'host', ipc: 'host', cap_add: ['NET_ADMIN'], cap_drop: ['ALL'],
      device: ['/dev/null:/dev/x'], security_opt: ['seccomp=unconfined'], sysctl: ['net.ipv4.ip_forward=1'], gpus: 'all',
    });
    expect(created(c).error).toBeNull();
    // booleans can be written =false, a plain memory number is bytes (the editor reads a plain number as MB)
    expect(conv('docker run --init=false -m 536870912 --tty=true img').fill).toEqual({ image: 'img', init: 'false', memory: '536870912b', tty: 'true' });
  });

  it.skipIf(!hasSh)('every flag it cannot convert is named in errors, with its value and the reason', () => {
    const c = conv('docker run -d --name web --cpu-shares 512 --weird thing --ulimit nofile=1:2 -P --env-file .env -e KEY -v /data -v ./rel:/r --label-file l --no-healthcheck --platform linux/arm64 --network container:x --restart sometimes -p abc --stop-timeout x --mount type=volume,target=/v nginx');
    expect(c.fill).toEqual({ name: 'web', image: 'nginx' });
    expect(c.errors).toEqual([
      'Not converted: --cpu-shares 512 (not supported by the editor)',
      'Not converted: --weird thing (unknown flag, not supported by the editor)',
      'Not converted: --ulimit nofile=1:2 (not supported by the editor)',
      'Not converted: -P (random published ports are not supported: use -p)',
      'Not converted: --env-file .env (the file is not available here: put the variables in -e options)',
      'Not converted: -e KEY (takes the value from the environment of the person who runs docker: write KEY=value)',
      'Not converted: -v /data (anonymous volumes are not supported: give the volume a name (name:/path))',
      'Not converted: -v ./rel:/r (a relative host path is not supported: use an absolute path or a volume name)',
      'Not converted: --label-file l (the file is not available here: put the labels in -l options)',
      'Not converted: --no-healthcheck (disabling a health check is not supported by the editor)',
      'Not converted: --platform linux/arm64 (choosing a platform is not supported by the editor)',
      'Not converted: --network container:x (sharing the network of another container is not supported)',
      'Not converted: --restart sometimes (use no, always, unless-stopped, on-failure or on-failure:N)',
      'Not converted: -p abc (not a valid port mapping)',
      'Not converted: --stop-timeout x (use a number of seconds)',
      'Not converted: --mount type=volume,target=/v (anonymous volumes are not supported: give the volume a name)',
    ]);
    // a flag that is unknown but is the last thing before the image does not swallow the image
    expect(conv('docker run --odd nginx').fill).toEqual({ image: 'nginx' });
    expect(conv('docker run --odd nginx').errors).toEqual(['Not converted: --odd (unknown flag, not supported by the editor)']);
    // mounts
    const m = conv('docker run --mount type=bind,source=/srv/x,target=/x,readonly --mount type=tmpfs,target=/t,tmpfs-size=10m --mount type=volume,src=v1,dst=/v --mount type=bind,source=/a,target=/b,bind-propagation=rshared nginx');
    expect(m.fill).toEqual({ image: 'nginx', volume: ['/srv/x:/x:ro', 'v1:/v'], tmpfs: ['/t:size=10m'] });
    expect(m.errors).toEqual(['Not converted: --mount type=bind,source=/a,target=/b,bind-propagation=rshared (the mount option bind-propagation is not supported)']);
  });

  it.skipIf(!hasSh)('$(...) and backticks are refused with an error that names them, and nothing is ever run; $VAR stays text with a note', () => {
    for (const [text, name] of [['docker run -e A=$(touch pwned) nginx', '$(...)'], ['docker run -e A="`touch pwned`" nginx', 'backticks'], ['docker run nginx $(touch pwned)', '$(...)'], ['docker run -e "A=$(touch pwned)" nginx', '$(...)']] as const) {
      const c = conv(text);
      expect(c.fill).toEqual({});
      expect(c.errors).toHaveLength(1);
      expect(c.errors[0]).toContain(name);
      expect(c.errors[0]).toMatch(/^Refused:/);
    }
    // inside single quotes it is plain text
    expect(conv('docker run -e \'A=$(not run) `no`\' nginx').fill).toEqual({ image: 'nginx', env: ['A=$(not run) `no`'] });
    expect(fs.existsSync(path.join(bin, 'pwned'))).toBe(false);
    const v = conv('docker run -e A=$HOME/x -e "B=${PORT}" -v $PWD/data:/d --name web nginx');
    expect(v.fill).toEqual({ name: 'web', image: 'nginx', env: ['A=$HOME/x', 'B=${PORT}'], volume: ['$PWD/data:/d'] });
    expect(v.errors).toEqual([]);
    expect(v.notes).toEqual(['Variables such as $VAR are kept as text: Docker does not expand them here, so replace them with their values']);
    // single-quoted and escaped dollars are not variables
    expect(conv('docker run -e \'A=$HOME\' -e B=\\$HOME nginx').notes).toEqual([]);
  });

  it.skipIf(!hasSh)('shell operators end the command (named in errors), a second command is not converted, and text that is no docker command says so', () => {
    const a = conv('docker run -e A=1 nginx; rm -rf /');
    expect(a.fill).toEqual({ image: 'nginx', env: ['A=1'] });
    expect(a.errors).toEqual(['Not converted: ; rm -rf / (shell operators such as ; | & < > are not supported; the rest of the line was left out)']);
    expect(conv('docker run nginx | tee out').errors[0]).toMatch(/^Not converted: \| tee out/);
    expect(conv('docker run nginx && docker run other').errors[0]).toMatch(/^Not converted: && docker run other/);
    const b = conv('docker run nginx\ndocker run other');
    expect(b.fill).toEqual({ image: 'nginx' });
    expect(b.errors).toEqual(['Not converted: docker run other (only the first command was converted)']);
    expect(conv('ls -la').errors).toEqual(['This is not a docker run command (it should start with docker run).']);
    expect(conv('docker ps').errors).toEqual(['This is not a docker run command (it should start with docker run or docker create).']);
    expect(conv('docker run --name x').errors).toEqual(['No image was found in the command.']);
    expect(conv('docker run "unterminated nginx').errors).toEqual(['The command has an unterminated quote.']);
    expect(conv('   \n ').errors).toEqual(['Paste a docker run command or a compose file.']);
    expect(conv('# only a comment\n').errors).toEqual(['Paste a docker run command or a compose file.']);
    expect(conv('docker container run --rm -- nginx -x').fill).toEqual({ image: 'nginx', cmd: ['-x'] });
    expect(conv('docker run --name c \\\n  nginx # d').fill).toEqual({ name: 'c', image: 'nginx' });
    // a comment ends at its line: the command ends there too (as in a shell)
    expect(conv('docker run # c\n  --name c\n  nginx').errors).toEqual(['No image was found in the command.']);
  });

  it.skipIf(!hasSh)('limit of 2000 lines', () => {
    // blank lines keep the parameter short (the shell of Windows cuts a command line at 8 KB)
    expect(conv('docker run nginx' + '\n'.repeat(2001)).errors).toEqual(['The text has too many lines (at most 2000).']);
    expect(conv('docker run nginx' + '\n'.repeat(1990)).errors).toEqual([]);
  });

  // (a 64 KB parameter does not fit the command line of Windows, so the character limit is only exercised on Linux)
  it.skipIf(!hasSh || process.platform === 'win32')('limit of 65536 characters', () => {
    expect(conv('docker run -e A=' + 'x'.repeat(65536) + ' nginx').errors).toEqual(['The text is too long (at most 65536 characters).']);
    expect(conv('docker run -e A=' + 'x'.repeat(60000) + ' nginx').fill.env).toHaveLength(1);
  });

  describe('a compose file', () => {
    const YAML = lines(['# two services; web is first in the file, db first in the alphabet', 'services:', '  web:', '    image: nginx:alpine', '    container_name: webby', '    build: .', '    depends_on: [db]', '    ulimits:', '      nofile: 1024', '  db:', '    image: postgres:16', '']);
    /** The fake prints `docker compose config` as compose does; @PD@ stands for the project folder the script chose. */
    const composeFake = (cfg: string, extra = '') => {
      fs.writeFileSync(path.join(bin, 'cfg.json'), cfg);
      fake(`case "$1 $2" in "compose version") echo v5; exit 0 ;; esac
case "$*" in *' config '*)
  pd=''; p=0; for a in "$@"; do if [ $p = 1 ]; then pd=$a; p=0; fi; [ "$a" = --project-directory ] && p=1; done
  ${extra}
  sed "s#@PD@#$pd#g" "${sp(path.join(bin, 'cfg.json'))}" ;;
esac
exit 0`);
    };
    const CFG_S2 = lines([
    "{",
    "  \"name\": \"bosun-convert\",",
    "  \"networks\": {",
    "    \"default\": {",
    "      \"name\": \"bosun-convert_default\"",
    "    },",
    "    \"front\": {",
    "      \"external\": true,",
    "      \"name\": \"bsbt-net\"",
    "    }",
    "  },",
    "  \"services\": {",
    "    \"db\": {",
    "      \"image\": \"postgres:16\",",
    "      \"networks\": {",
    "        \"default\": null",
    "      }",
    "    },",
    "    \"web\": {",
    "      \"build\": {",
    "        \"context\": \"@PD@\",",
    "        \"dockerfile\": \"Dockerfile\"",
    "      },",
    "      \"command\": \"sleep 5 \\\"a b\\\"\",",
    "      \"container_name\": \"webby\",",
    "      \"cpus\": 0.5,",
    "      \"depends_on\": {",
    "        \"db\": {",
    "          \"condition\": \"service_started\",",
    "          \"required\": true",
    "        }",
    "      },",
    "      \"devices\": [",
    "        {",
    "          \"permissions\": \"rwm\",",
    "          \"source\": \"/dev/null\",",
    "          \"target\": \"/dev/x\"",
    "        }",
    "      ],",
    "      \"dns\": [",
    "        \"1.1.1.1\"",
    "      ],",
    "      \"entrypoint\": [",
    "        \"/bin/sh\",",
    "        \"-c\"",
    "      ],",
    "      \"environment\": {",
    "        \"A\": \"1\",",
    "        \"B\": \"${UNSET_VAR}\",",
    "        \"C\": null,",
    "        \"D\": 2",
    "      },",
    "      \"extra_hosts\": [",
    "        \"h:10.0.0.1\"",
    "      ],",
    "      \"healthcheck\": {",
    "        \"interval\": \"1m30s\",",
    "        \"test\": \"curl -f http://localhost\"",
    "      },",
    "      \"image\": \"nginx:alpine\",",
    "      \"labels\": [",
    "        \"a=b\",",
    "        \"c\"",
    "      ],",
    "      \"mem_limit\": \"512m\",",
    "      \"networks\": {",
    "        \"front\": null",
    "      },",
    "      \"ports\": [",
    "        {",
    "          \"mode\": \"ingress\",",
    "          \"protocol\": \"tcp\",",
    "          \"published\": \"8080\",",
    "          \"target\": 80",
    "        },",
    "        {",
    "          \"host_ip\": \"127.0.0.1\",",
    "          \"mode\": \"ingress\",",
    "          \"protocol\": \"tcp\",",
    "          \"published\": \"8443\",",
    "          \"target\": 443",
    "        },",
    "        {",
    "          \"mode\": \"ingress\",",
    "          \"protocol\": \"udp\",",
    "          \"published\": 5353,",
    "          \"target\": 53",
    "        }",
    "      ],",
    "      \"restart\": \"unless-stopped\",",
    "      \"stop_grace_period\": \"1m10s\",",
    "      \"sysctls\": {",
    "        \"net.core.somaxconn\": 1024",
    "      },",
    "      \"tmpfs\": \"/run\",",
    "      \"ulimits\": {",
    "        \"nofile\": 1024",
    "      },",
    "      \"user\": \"1000\",",
    "      \"volumes\": [",
    "        {",
    "          \"bind\": {",
    "            \"create_host_path\": true",
    "          },",
    "          \"read_only\": true,",
    "          \"source\": \"@PD@/data\",",
    "          \"target\": \"/data\",",
    "          \"type\": \"bind\"",
    "        },",
    "        {",
    "          \"source\": \"named\",",
    "          \"target\": \"/n\",",
    "          \"type\": \"volume\",",
    "          \"volume\": {}",
    "        },",
    "        {",
    "          \"bind\": {",
    "            \"create_host_path\": true",
    "          },",
    "          \"source\": \"/abs\",",
    "          \"target\": \"/a\",",
    "          \"type\": \"bind\"",
    "        },",
    "        {",
    "          \"target\": \"/t\",",
    "          \"type\": \"tmpfs\"",
    "        }",
    "      ]",
    "    }",
    "  },",
    "  \"volumes\": {",
    "    \"named\": {",
    "      \"name\": \"bosun-convert_named\"",
    "    }",
    "  }",
    "}",
  ]);
    const CFG_K1 = lines([
    "{",
    "  \"name\": \"bosun-convert\",",
    "  \"networks\": {",
    "    \"backend\": {",
    "      \"name\": \"bosun-convert_backend\"",
    "    }",
    "  },",
    "  \"services\": {",
    "    \"app\": {",
    "      \"build\": {",
    "        \"context\": \"@PD@\",",
    "        \"dockerfile\": \"Dockerfile\"",
    "      },",
    "      \"environment\": [",
    "        \"NODE_ENV=production\",",
    "        \"TOKEN=pa$$word\"",
    "      ],",
    "      \"networks\": {",
    "        \"backend\": null",
    "      },",
    "      \"ports\": [",
    "        {",
    "          \"mode\": \"ingress\",",
    "          \"protocol\": \"tcp\",",
    "          \"published\": \"3000\",",
    "          \"target\": 3000",
    "        }",
    "      ]",
    "    }",
    "  }",
    "}",
  ]);
    const CFG_K2 = lines([
    "{",
    "  \"name\": \"bosun-convert\",",
    "  \"networks\": {",
    "    \"default\": {",
    "      \"name\": \"bosun-convert_default\"",
    "    },",
    "    \"shared\": {",
    "      \"external\": true,",
    "      \"name\": \"bsbt-net\"",
    "    }",
    "  },",
    "  \"services\": {",
    "    \"cache\": {",
    "      \"image\": \"redis:7\",",
    "      \"networks\": {",
    "        \"default\": null",
    "      }",
    "    },",
    "    \"web\": {",
    "      \"deploy\": {",
    "        \"replicas\": 2,",
    "        \"resources\": {",
    "          \"limits\": {",
    "            \"cpus\": \"0.5\",",
    "            \"memory\": \"256M\"",
    "          },",
    "          \"reservations\": {",
    "            \"devices\": [",
    "              {",
    "                \"capabilities\": [",
    "                  \"gpu\"",
    "                ],",
    "                \"count\": 2,",
    "                \"driver\": \"nvidia\"",
    "              }",
    "            ]",
    "          }",
    "        }",
    "      },",
    "      \"expose\": [",
    "        \"9000\"",
    "      ],",
    "      \"healthcheck\": {",
    "        \"interval\": \"10s\",",
    "        \"retries\": 3,",
    "        \"start_period\": \"5s\",",
    "        \"test\": [",
    "          \"CMD\",",
    "          \"wget\",",
    "          \"-q\",",
    "          \"--spider\",",
    "          \"http://localhost/\"",
    "        ],",
    "        \"timeout\": \"2s\"",
    "      },",
    "      \"image\": \"nginx:1.27\",",
    "      \"networks\": {",
    "        \"shared\": null",
    "      },",
    "      \"platform\": \"linux/amd64\",",
    "      \"ports\": [",
    "        {",
    "          \"mode\": \"ingress\",",
    "          \"protocol\": \"tcp\",",
    "          \"published\": \"8080\",",
    "          \"target\": 80",
    "        }",
    "      ],",
    "      \"pull_policy\": \"always\",",
    "      \"volumes\": [",
    "        {",
    "          \"read_only\": true,",
    "          \"source\": \"data\",",
    "          \"target\": \"/usr/share/nginx/html\",",
    "          \"type\": \"volume\",",
    "          \"volume\": {}",
    "        },",
    "        {",
    "          \"bind\": {",
    "            \"create_host_path\": true",
    "          },",
    "          \"source\": \"@PD@/conf\",",
    "          \"target\": \"/etc/nginx/conf.d\",",
    "          \"type\": \"bind\"",
    "        },",
    "        {",
    "          \"bind\": {",
    "            \"create_host_path\": true",
    "          },",
    "          \"source\": \"/var/run/docker.sock\",",
    "          \"target\": \"/var/run/docker.sock\",",
    "          \"type\": \"bind\"",
    "        }",
    "      ]",
    "    }",
    "  },",
    "  \"volumes\": {",
    "    \"data\": {",
    "      \"external\": true,",
    "      \"name\": \"data\"",
    "    }",
    "  }",
    "}",
  ]);

    it.skipIf(!hasSh)('is resolved by docker compose config (without expanding variables, in a folder that is removed), and the first service in the file is converted', () => {
      const t = privateTmp();
      composeFake(CFG_S2);
      const input = lines(['services:', '  web:', '    image: nginx:alpine', '    container_name: webby', '  db:', '    image: postgres:16']);
      const c = conv(input, { TMPDIR: t.TMPDIR });
      expect(c.fill.name).toBe('webby');
      expect(c.fill.image).toBe('nginx:alpine');
      const call = dockerCalls().find((x) => x[0] === 'compose' && x.includes('config'))!;
      expect(call).toEqual(expect.arrayContaining(['-p', 'bosun-convert', '--no-interpolate', '--format', 'json']));
      expect(call.join(' ')).not.toMatch(/\$|\.\.|;/);
      expect(c.notes).toContain('The compose file has more than one service; only web was converted (not converted: db)');
      expect(fs.readdirSync(t.dir)).toEqual([]);
    });

    it.skipIf(!hasSh)('maps the fields of the service to the keys, and names what cannot be converted (build, depends_on, ulimits, relative paths, other networks...)', () => {
      composeFake(CFG_S2);
      const c = conv(lines(['services:', '  web:', '    image: nginx:alpine', '  db:', '    image: x']));
      expect(c.fill).toEqual({
        name: 'webby', image: 'nginx:alpine', cmd: ['sleep', '5', 'a b'], entrypoint: ['/bin/sh', '-c'], env: ['A=1', 'B=${UNSET_VAR}', 'D=2'], port: ['8080:80', '127.0.0.1:8443:443', '5353:53/udp'],
        volume: ['named:/n', '/abs:/a'], tmpfs: ['/t', '/run'], label: ['a=b', 'c='], network: 'bsbt-net', restart: 'unless-stopped', user: '1000', memory: '512m', cpus: '0.5', dns: ['1.1.1.1'], add_host: ['h:10.0.0.1'],
        stop_timeout: '70', health_cmd: 'curl -f http://localhost', health_interval: '90s', device: ['/dev/null:/dev/x:rwm'], sysctl: ['net.core.somaxconn=1024'],
      });
      expect(c.errors).toEqual([
        'Not converted: build (building the image from a Dockerfile is not supported; the image nginx:alpine is used as it is)',
        'Not converted: environment C (it takes its value from the environment of the host running docker compose; write KEY=value)',
        'Not converted: volumes ./data:/data (a relative host path is not supported: use an absolute path)',
        'Not converted: depends_on (the start order of services is not supported: deploy it as a stack instead)',
        'Not converted: ulimits (not in the list of settings the editor can set)',
      ]);
      expect(c.notes).toEqual(['The compose file has more than one service; only web was converted (not converted: db)', 'Compose variables such as ${VAR} are not expanded: they are kept as text, so replace them with their values']);
      expect(Object.keys(c.fill).every((k) => KEYS.includes(k))).toBe(true);
    });

    it.skipIf(!hasSh)('a file with build: and no image, an undefined network, deploy limits and GPUs, an external volume and network', () => {
      composeFake(CFG_K1);
      const a = conv(lines(['services:', '  app:', '    build: .']));
      expect(a.fill).toEqual({ name: 'app', env: ['NODE_ENV=production', 'TOKEN=pa$word'], port: ['3000:3000'] });
      expect(a.errors).toEqual([
        'Not converted: build (this service builds its image from a Dockerfile, which the editor cannot do; give the service an image instead)',
        'Not converted: networks backend (the network is defined in the compose file and does not exist yet: create it, mark it external, or use a stack)',
      ]);
      composeFake(CFG_K2);
      const b = conv(lines(['services:', '  web:', '    image: x', '  cache:', '    image: redis:7']));
      expect(b.fill).toEqual({
        name: 'web', image: 'nginx:1.27', port: ['8080:80'], volume: ['data:/usr/share/nginx/html:ro', '/var/run/docker.sock:/var/run/docker.sock'], network: 'bsbt-net', memory: '256M', cpus: '0.5',
        health_cmd: 'wget -q --spider http://localhost/', health_interval: '10s', health_timeout: '2s', health_retries: '3', gpus: '2',
      });
      expect(b.errors).toEqual([
        'Not converted: volumes ./conf:/etc/nginx/conf.d (a relative host path is not supported: use an absolute path)',
        'Not converted: healthcheck start_period 5s (the health check start period is not supported by the editor)',
        'Not converted: deploy replicas (only resource limits and GPU reservations are converted)',
        'Not converted: platform (not supported by the editor)',
      ]);
      expect(b.notes).toEqual(expect.arrayContaining(['expose was ignored: it only documents ports, nothing is published', 'pull_policy was ignored: a missing image is pulled, an existing one is used as it is']));
      expect(created(b).error).toBeNull();
    });

    it.skipIf(!hasSh)('refuses env_file, include and extends without running compose; reports the message of compose when it cannot read the file; needs compose', () => {
      composeFake(CFG_S2);
      for (const key of ['env_file: .env', 'include: [other.yaml]', 'extends: {file: x.yaml, service: a}']) {
        fs.writeFileSync(log, '');
        const c = conv(lines(['services:', '  a:', '    image: x', `    ${key}`]));
        expect(c.fill).toEqual({});
        expect(c.errors[0]).toMatch(/^Not converted: (env_file|include|extends)/);
        expect(dockerCalls().some((x) => x[0] === 'compose' && x.includes('config'))).toBe(false);
      }
      fake(`case "$1 $2" in "compose version") exit 0 ;; esac
echo "yaml: line 3: did not find expected key" >&2; exit 1`);
      expect(conv(lines(['services:', '  a:', ' image: [x'])).errors).toEqual(['Docker Compose could not read the file: yaml: line 3: did not find expected key ']);
      fake('case "$1 $2" in "compose version") exit 1 ;; esac');
      expect(conv(lines(['services:', '  a:', '    image: x'])).errors[0]).toMatch(/is not installed on this host/);
      noDocker();
      expect(conv(lines(['services:', '  a:', '    image: x'])).errors[0]).toMatch(/Docker is not available/);
      composeFake('{"services": {}}');
      expect(conv(lines(['services:', '  a:', '    image: x'])).errors).toEqual(['The compose file has no services.']);
    });
  });
});

describe('exposed_ports (dataset)', () => {
  /** An image with the given exposed ports (the template output: one `80/tcp` per line); `ssPorts` are listening on the host. */
  const portsFake = (o: { exposed?: string[]; missing?: boolean; pullFails?: boolean; published?: string[]; listening?: [number, number] } = {}) => {
    const flag = path.join(bin, 'pulled');
    fs.rmSync(flag, { force: true });
    fake(`case "$1 $2" in
  "image inspect") case "$*" in *'{{.Id}}'*) ${o.missing ? `[ -f "${sp(flag)}" ] || exit 1` : ':'} ;; *) printf '%s\\n' ${(o.exposed ?? ['80/tcp']).map((p) => `'${p}'`).join(' ')} ;; esac ;;
  "pull "*) ${o.pullFails ? 'echo "Error response from daemon: pull access denied for img, repository does not exist" >&2; exit 1' : `touch "${sp(flag)}"`} ;;
  "ps -aq") echo ${'1'.repeat(64)} ;;
  "inspect --type") printf '%s\\n' ${(o.published ?? []).map((p) => `'${p}'`).join(' ')} ;;
esac
exit 0`);
    fakeCmd('ss', `${o.listening ? `echo 'Netid State Recv-Q Send-Q Local Address:Port Peer Address:Port'; seq ${o.listening[0]} ${o.listening[1]} | awk '{ printf "tcp LISTEN 0 4096 0.0.0.0:%s 0.0.0.0:*\\n", $1 }'` : ':'}`);
  };
  const ports = (ref = 'nginx:alpine') => json('exposed_ports.sh', { ref }) as { fill: { port: string[] }; errors: string[]; notes: string[] };

  it.skipIf(!hasSh)('maps each exposed port to a random free host port in 49152-65535, in numeric order, none twice', () => {
    portsFake({ exposed: ['443/tcp', '80/tcp', '53/udp', '8080/tcp'] });
    const r = ports();
    expect(r.errors).toEqual([]);
    expect(r.notes).toEqual(['The image exposes 53/udp, 80/tcp, 443/tcp, 8080/tcp']);
    expect(r.fill.port).toHaveLength(4);
    const hosts = r.fill.port.map((p) => Number(p.split(':')[0]));
    expect(r.fill.port.map((p) => p.split(':')[1])).toEqual(['53/udp', '80/tcp', '443/tcp', '8080/tcp']);
    for (const h of hosts) { expect(h).toBeGreaterThanOrEqual(49152); expect(h).toBeLessThanOrEqual(65535); }
    expect(new Set(hosts).size).toBe(4);
    // random: several answers are not all the same
    const seen = new Set<string>(); for (let i = 0; i < 4; i++) seen.add(ports().fill.port[0]);
    expect(seen.size).toBeGreaterThan(1);
  });

  it.skipIf(!hasSh)('avoids ports that are listening on the host and ports that containers publish', () => {
    const published = ['65152', '65153', '65154', '65155', '65156', '65157', '65158', '65159', '65160', '65161'];
    portsFake({ exposed: ['1/tcp', '2/tcp', '3/tcp', '4/tcp', '5/tcp'], listening: [49152, 65151], published });   // 49152..65151 listen, 65152..65161 are published
    const r = ports();
    const hosts = r.fill.port.map((p) => Number(p.split(':')[0]));
    expect(hosts).toHaveLength(5);
    for (const h of hosts) { expect(h).toBeGreaterThanOrEqual(65162); expect(h).toBeLessThanOrEqual(65535); }
    expect(new Set(hosts).size).toBe(5);
    expect(dockerCalls().some((c) => c[0] === 'inspect' && c.includes(`--type`))).toBe(true);
  });

  it.skipIf(!hasSh)('no exposed ports: an empty list and a note; a missing image is pulled first; a failed pull is an error in the answer', () => {
    portsFake({ exposed: [] });
    const none = ports('alpine:3.20');
    expect(none.fill.port).toEqual([]);
    expect(none.notes).toEqual(['The image alpine:3.20 does not expose any ports (no EXPOSE).']);
    portsFake({ missing: true });
    const r = ports('nginx:alpine');
    expect(r.fill.port).toHaveLength(1);
    expect(dockerCalls().map((c) => c.slice(0, 2).join(' '))).toContain('pull nginx:alpine');
    portsFake({ missing: true, pullFails: true });
    const bad = ports('nope:1');
    expect(bad.fill.port).toEqual([]);
    expect(bad.errors).toEqual(['The image nope:1 is not on this host and could not be pulled: Error response from daemon: pull access denied for img, repository does not exist']);
    // an odd reference never reaches docker; without ss or netstat the note says that the host could not be checked
    fs.writeFileSync(log, '');
    expect(run('exposed_ports.sh', { ref: 'a b' }).stdout).toBe('ERROR: invalid image reference\n');
    expect(run('exposed_ports.sh', { ref: '-x' }).stdout).toBe('ERROR: invalid image reference\n');
    expect(dockerCalls()).toEqual([]);
    noDocker();
    expect(run('exposed_ports.sh', { ref: 'nginx' }).stdout).toBe('ERROR: Docker is not available to this account\n');
  });
});

describe('git datasets: git_branches, git_files, git_services', () => {
  const TOKEN = 'ghp_SECRET0123456789abcdef';
  /** A fake git: ls-remote prints `lsremote`, clone creates the files of `repoFiles` in the destination, ls-tree prints `tree`; every call logs the environment lines that matter. */
  const gitFake = (o: { lsremote?: string; tree?: string; repoFiles?: Record<string, string>; fails?: string } = {}) => {
    fs.writeFileSync(path.join(bin, 'lsremote.txt'), o.lsremote ?? '');
    fs.writeFileSync(path.join(bin, 'tree.txt'), o.tree ?? '');
    const make = Object.entries(o.repoFiles ?? {}).map(([f, c]) => `mkdir -p "$last/$(dirname ${f})"; printf '%s' '${c.replace(/'/g, `'\\''`)}' > "$last/${f}"`).join('\n');
    fakeCmd('git', `
{ echo "ENV GIT_CONFIG_COUNT=$GIT_CONFIG_COUNT"; echo "ENV GIT_CONFIG_VALUE_0=$GIT_CONFIG_VALUE_0"; echo "ENV GIT_CONFIG_KEY_1=$GIT_CONFIG_KEY_1"; echo "ENV GIT_ALLOW_PROTOCOL=$GIT_ALLOW_PROTOCOL"; echo "ENV GIT_TERMINAL_PROMPT=$GIT_TERMINAL_PROMPT"; echo "ENV SECRET=$BOSUN_SECRET_git_token"; } >> "$LOG"
${o.fails ? `echo '${o.fails}' >&2; exit 128` : ''}
case "$*" in
  *ls-remote*) cat "${sp(path.join(bin, 'lsremote.txt'))}" ;;
  *' clone '*) for last; do :; done; mkdir -p "$last/.git"; ${make} ;;
  *ls-tree*) cat "${sp(path.join(bin, 'tree.txt'))}" ;;
esac
exit 0`);
  };
  const gitCalls = () => calls().filter((c) => c[0] === 'git').map((c) => c.slice(1).filter((a) => !a.startsWith('ENV ')));
  const envLines = () => fs.readFileSync(log, 'utf8').split('\n').filter((l) => l.startsWith('ENV '));
  const R = 'https://github.com/o/r';
  const T = '\t';

  it.skipIf(!hasSh)('the git helpers are the very same text in the three scripts, and so is the JSON reader of convert and git_services', () => {
    const block = (f: string, name: string) => new RegExp(`# >>> ${name}[\\s\\S]*# <<< ${name}`).exec(script(f))![0];
    expect(block('git_branches.sh', 'git helpers')).toBe(block('git_files.sh', 'git helpers'));
    expect(block('git_branches.sh', 'git helpers')).toBe(block('git_services.sh', 'git helpers'));
    expect(block('convert.sh', 'json flatten')).toBe(block('git_services.sh', 'json flatten'));
    expect(block('git_services.sh', 'json flatten').length).toBeGreaterThan(2000);
  });

  it.skipIf(!hasSh)('git_branches: the default branch first, then alphabetical; names stack_deploy would refuse are left out; only ls-remote runs', () => {
    gitFake({ lsremote: `ref: refs/heads/main${T}HEAD\n1111${T}HEAD\n2222${T}refs/heads/zeta\n3333${T}refs/heads/main\n4444${T}refs/heads/dev\n5555${T}refs/heads/feature/x-1\n6666${T}refs/heads/bad name\n7777${T}refs/heads/a..b\n8888${T}refs/heads/-x\n` });
    expect(json('git_branches.sh', { repo: R })).toEqual({ items: [{ name: 'main', default: true }, { name: 'dev', default: false }, { name: 'feature/x-1', default: false }, { name: 'zeta', default: false }] });
    expect(gitCalls()).toEqual([['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'protocol.file.allow=never', 'ls-remote', '--symref', '--', R, 'HEAD', 'refs/heads/*']]);
    // an old git prints no symref line: the default is the branch HEAD points at
    gitFake({ lsremote: `aaaa${T}HEAD\nbbbb${T}refs/heads/dev\naaaa${T}refs/heads/master\n` });
    expect(json('git_branches.sh', { repo: R })).toEqual({ items: [{ name: 'master', default: true }, { name: 'dev', default: false }] });
    gitFake({ lsremote: '' });
    expect(json('git_branches.sh', { repo: R })).toEqual({ items: [] });
  });

  it.skipIf(!hasSh)('git_branches, git_files and git_services: the token only in the environment of git, only for github.com; https and odd names refused', () => {
    for (const [f, p] of [['git_branches.sh', {}], ['git_files.sh', { branch: 'main' }], ['git_services.sh', { branch: 'main', file: 'compose.yaml' }]] as const) {
      gitFake({ lsremote: `ref: refs/heads/main${T}HEAD\n1${T}refs/heads/main\n`, tree: `100644 blob abc${T}docker-compose.yml\n`, repoFiles: { 'compose.yaml': 'services: {}\n' } });
      fake('exit 0');   // for git_services: docker and compose exist (the config it prints is empty)
      fs.writeFileSync(log, '');
      run(f, { repo: R, ...p }, { BOSUN_SECRET_git_token: TOKEN });
      const expected = 'Authorization: Basic ' + Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
      expect(envLines().filter((l) => l.startsWith('ENV GIT_CONFIG_VALUE_0=')).every((l) => l === `ENV GIT_CONFIG_VALUE_0=${expected}`), f).toBe(true);
      expect(envLines()).toContain('ENV GIT_CONFIG_COUNT=2');
      expect(envLines()).toContain('ENV GIT_ALLOW_PROTOCOL=https');
      expect(envLines()).toContain('ENV GIT_TERMINAL_PROMPT=0');
      expect(envLines()).toContain('ENV SECRET=');
      expect(fs.readFileSync(log, 'utf8').replace(expected, '')).not.toContain(TOKEN);
      expect(gitCalls().flat().join(' ')).not.toContain(TOKEN);
      fs.writeFileSync(log, '');
      run(f, { repo: 'https://gitlab.com/o/r', ...p }, { BOSUN_SECRET_git_token: TOKEN });
      expect(envLines().every((l) => !l.includes('Authorization') && l !== 'ENV GIT_CONFIG_COUNT=2'), f).toBe(true);
      expect(run(f, { repo: R, ...p }, { BOSUN_SECRET_git_token: 'a b' }).stdout, f).toBe('ERROR: the Git token has unexpected characters\n');
      for (const [repo, why] of [['http://github.com/o/r', /^ERROR: repo: use an https/], ['https://github.com', /^ERROR: repo: use https:\/\/host\/owner\/name/], ['https://-x.com/o/r', /invalid host/], ['https://github.com/o/../r', /invalid path/], ['https://github.com/o/r;x', /invalid path/], ['file:///etc', /use an https/]] as const) {
        expect(run(f, { repo, ...p }).stdout, `${f} ${repo}`).toMatch(why);
      }
    }
  });

  it.skipIf(!hasSh)('git_branches: a repository git cannot read is an ERROR with git\'s words', () => {
    gitFake({ fails: 'fatal: repository not found' });
    expect(run('git_branches.sh', { repo: R }).stdout).toBe('ERROR: git could not read the repository: fatal: repository not found \n');
    noDocker();   // git needs no Docker at all
    fakeCmd('git', 'case "$*" in *ls-remote*) printf "ref: refs/heads/main\\tHEAD\\n1\\trefs/heads/main\\n" ;; esac');
    expect(json('git_branches.sh', { repo: R })).toEqual({ items: [{ name: 'main', default: true }] });
  });

  it.skipIf(!hasSh)('git_files: compose files up to 3 folders deep, root first then alphabetical, no links, submodules, node_modules or odd names; the temp folder is removed', () => {
    const tree = [
      ['100644 blob', 'docker-compose.yml'], ['100644 blob', 'compose.yaml'], ['100644 blob', 'docker-compose.prod.yaml'], ['100644 blob', 'README.md'], ['100644 blob', 'deploy/compose.yaml'], ['100644 blob', 'a/b/c/docker-compose.yml'],
      ['100644 blob', 'a/b/c/d/compose.yml'], ['100644 blob', 'node_modules/x/compose.yml'], ['100644 blob', 'web/node_modules/compose.yml'], ['120000 blob', 'link/compose.yml'], ['120000 blob', 'compose.link.yml'], ['160000 commit', 'sub/compose.yml'],
      ['100644 blob', 'my dir/compose.yml'], ['100644 blob', 'sample-compose.yml'], ['100644 blob', 'composer.json'], ['100644 blob', 'z/docker-compose.override.yml'], ['100644 blob', 'docker-compose.yaml.bak'],
    ].map(([m, p]) => `${m} abc123${T}${p}`).join('\n') + '\n';
    gitFake({ tree });
    const t = privateTmp();
    const r = json('git_files.sh', { repo: R, branch: 'feature/x' }, { TMPDIR: t.TMPDIR });
    expect(r).toEqual({ items: ['compose.yaml', 'docker-compose.prod.yaml', 'docker-compose.yml', 'a/b/c/docker-compose.yml', 'deploy/compose.yaml', 'z/docker-compose.override.yml'] });
    expect(fs.readdirSync(t.dir)).toEqual([]);
    const c = gitCalls();
    expect(c[0].slice(6)).toEqual(['clone', '--quiet', '--depth', '1', '--single-branch', '--no-checkout', '--filter=blob:none', '--branch', 'feature/x', '--', R, expect.stringMatching(/\/repo$/)]);
    expect(c[1].slice(6, 7)).toEqual(['-C']);
    expect(c[1].slice(-3)).toEqual(['ls-tree', '-r', 'HEAD']);
    // no compose files at all
    gitFake({ tree: `100644 blob abc${T}README.md\n` });
    expect(json('git_files.sh', { repo: R, branch: 'main' })).toEqual({ items: [] });
    // a branch that is not there, and odd branch names
    gitFake({ fails: 'fatal: Remote branch nope not found in upstream origin' });
    expect(run('git_files.sh', { repo: R, branch: 'nope' }).stdout).toMatch(/^ERROR: git clone failed: fatal: Remote branch nope not found/);
    for (const b of ['', '-x', 'a..b', 'a b', 'a;b', 'x'.repeat(101)]) expect(run('git_files.sh', { repo: R, branch: b }).stdout, b).toMatch(/^ERROR: branch:/);
  });

  describe('git_services', () => {
    const CFG = `{
  "name": "r",
  "networks": {
    "backend": {
      "name": "r_backend"
    },
    "default": {
      "name": "r_default"
    }
  },
  "services": {
    "db": {
      "image": "postgres:16",
      "networks": {
        "backend": null
      },
      "volumes": [
        {
          "type": "volume",
          "source": "dbdata",
          "target": "/var/lib/postgresql/data"
        }
      ]
    },
    "web": {
      "container_name": "webby",
      "image": "nginx",
      "networks": {
        "backend": null,
        "default": null
      },
      "ports": [
        {
          "mode": "ingress",
          "host_ip": "127.0.0.1",
          "target": 80,
          "published": "8080",
          "protocol": "tcp"
        },
        {
          "mode": "ingress",
          "target": 53,
          "published": "5353",
          "protocol": "udp"
        },
        {
          "mode": "ingress",
          "target": 9000,
          "protocol": "tcp"
        }
      ],
      "volumes": [
        {
          "type": "bind",
          "source": "@PD@/data",
          "target": "/data",
          "read_only": true
        },
        {
          "type": "bind",
          "source": "/abs/path",
          "target": "/abs"
        },
        {
          "type": "tmpfs",
          "target": "/t"
        }
      ]
    },
    "worker": {
      "build": {
        "context": "@PD@"
      }
    }
  }
}`;
    const FILE = 'services:\n  web:\n    image: nginx\n  db:\n    image: postgres:16\n  worker:\n    build: .\n';
    /** compose fake: the first call may fail with `firstErr`; `--no-interpolate` calls print the raw file. */
    const svcFake = (o: { cfg?: string; firstErr?: string; warn?: string } = {}) => {
      fs.writeFileSync(path.join(bin, 'cfg.json'), o.cfg ?? CFG);
      gitFake({ repoFiles: { 'deploy/compose.yaml': FILE } });
      fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/sh
[ "$1" = ps ] && [ $# -eq 1 ] && exit 0
{ echo "CALL docker"; for a in "$@"; do printf 'ARG %s\\n' "$a"; done; } >> "${sp(log)}"
case "$*" in 'compose version') exit 0 ;; esac
pd=''; p=0; for a in "$@"; do if [ $p = 1 ]; then pd=$a; p=0; fi; [ "$a" = --project-directory ] && p=1; done
case "$*" in *' config '*) env | grep -E '^(BOSUN|MY_)' | sed 's/^/ENV /' >> "${sp(log)}" ;; esac
case "$*" in
  *--no-interpolate*) sed "s#@PD@#$pd#g" "${sp(path.join(bin, 'cfg.json'))}" ;;
  *' config '*) ${o.firstErr ? `echo '${o.firstErr}' >&2; exit 1` : `${o.warn ? `echo '${o.warn}' >&2;` : ''} sed "s#@PD@#$pd#g" "${sp(path.join(bin, 'cfg.json'))}"`} ;;
esac
exit 0
`, { mode: 0o755 });
    };
    const svc = (extra: Record<string, string> = {}, env: Record<string, string> = {}) => json('git_services.sh', { repo: R, branch: 'main', file: 'deploy/compose.yaml', ...extra }, env);

    it.skipIf(!hasSh)('the services in the order of the file with ports, volumes and networks; "default" is the first network of the file', () => {
      svcFake();
      const t = privateTmp();
      expect(svc({}, { TMPDIR: t.TMPDIR, MY_SECRET: 'x', BOSUN_PARAM_secret: 'y' })).toEqual({
        services: [
          { name: 'web', container_name: 'webby', image: 'nginx', ports: ['127.0.0.1:8080:80/tcp', '5353:53/udp', '9000/tcp'], volumes: ['./data:/data:ro', '/abs/path:/abs'], networks: ['backend', 'default'] },
          { name: 'db', container_name: '', image: 'postgres:16', ports: [], volumes: ['dbdata:/var/lib/postgresql/data'], networks: ['backend'] },
          { name: 'worker', container_name: '', image: '', ports: [], volumes: [], networks: ['default'] },
        ],
        networks: ['default', 'backend'],
        warnings: [],
      });
      expect(fs.readdirSync(t.dir)).toEqual([]);
      const compose = dockerCalls().find((c) => c[0] === 'compose' && c.includes('config'))!;
      expect(compose.slice(0, 1)).toEqual(['compose']);
      expect(compose).toEqual(expect.arrayContaining(['--project-directory', '-f', 'config', '--format', 'json']));
      // compose runs with a clean environment: nothing of this host (a variable, a parameter, the token) is in it
      expect(envLines().filter((l) => /^ENV (MY_|BOSUN_)/.test(l))).toEqual([]);
    });

    it.skipIf(!hasSh)('unset variables are warnings; a required variable makes it read the file again without expanding, with a warning; a broken file is an ERROR', () => {
      svcFake({ warn: 'time="2026-10-31T17:44:21Z" level=warning msg="The \\"PORT\\" variable is not set. Defaulting to a blank string."' });
      expect((svc() as { warnings: string[] }).warnings).toEqual(['The variable PORT is not set (counted as blank)']);
      svcFake({ firstErr: 'error while interpolating services.a.environment.X: required variable REQ is missing a value: must be set' });
      fs.writeFileSync(log, '');
      const r = svc() as { services: unknown[]; warnings: string[] };
      expect(r.services).toHaveLength(3);
      expect(r.warnings).toEqual(['The file needs a variable that is not set (required variable REQ is missing a value: must be set): it is shown with the variables as written']);
      expect(dockerCalls().filter((c) => c[0] === 'compose' && c.includes('config')).map((c) => c.includes('--no-interpolate'))).toEqual([false, true]);
      svcFake({ firstErr: 'services must be a mapping' });
      expect(run('git_services.sh', { repo: R, branch: 'main', file: 'deploy/compose.yaml' }).stdout).toBe('ERROR: docker compose could not read the file: services must be a mapping \n');
    });

    it.skipIf(!hasSh)('refuses a file that is missing, outside or a link, odd names, and a missing Docker or compose', () => {
      svcFake();
      expect(run('git_services.sh', { repo: R, branch: 'main', file: 'nope.yaml' }).stdout).toBe('ERROR: the file nope.yaml was not found in the repository\n');
      for (const f of ['', '/etc/passwd', '../x', 'a b', '-x', 'a;b']) expect(run('git_services.sh', { repo: R, branch: 'main', file: f }).stdout, f).toMatch(/^ERROR: file:/);
      expect(run('git_services.sh', { repo: R, branch: '..', file: 'a.yaml' }).stdout).toMatch(/^ERROR: branch:/);
      fake('case "$1 $2" in "compose version") exit 1 ;; esac');
      expect(run('git_services.sh', { repo: R, branch: 'main', file: 'deploy/compose.yaml' }).stdout).toMatch(/^ERROR: Docker Compose .* is not installed/);
      noDocker();
      expect(run('git_services.sh', { repo: R, branch: 'main', file: 'deploy/compose.yaml' }).stdout).toBe('ERROR: Docker is not available to this account\n');
    });
  });
});
