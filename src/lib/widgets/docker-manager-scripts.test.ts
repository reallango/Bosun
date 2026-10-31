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
  const inv = buildScriptInvocation('linux', script(file), params);
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
  info) echo '8 7 0 1 36' ;;
  system) printf 'Images|55.11GB\\nContainers|182.1MB\\nLocal Volumes|400.5MB\\nBuild Cache|122.8GB\\n' ;;
  compose) exit 0 ;;
esac`);
    expect(JSON.parse(run('system.sh').stdout)).toEqual({ version: '29.9.2', containers: { total: 8, running: 7, paused: 0, stopped: 1 }, images: 36, disk: { images: '55.11GB', containers: '182.1MB', volumes: '400.5MB', cache: '122.8GB' }, compose: true });
    fake(`case "$1" in compose) exit 1 ;; info) echo garbage ;; esac`);
    expect(JSON.parse(run('system.sh').stdout)).toMatchObject({ version: '', compose: false, images: 0, containers: { total: 0 } });
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
    expect(out('image_prune.sh', { all: 'true' }).done).toBe('pruned images (Total reclaimed space: 1.5GB)');
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
      ['rmi', '-f', 'nginx:1'], ['rmi', 'nginx:1'], ['image', 'prune', '-f', '-a'], ['image', 'prune', '-f'],
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
    expect(j).toEqual({ name: 'web', source: 'editor', repo: '', branch: '', file: '', yaml, env: 'A=1\nB="x y"\n' });
    seed('g', { 'repo/deploy/compose.yaml': 'services: {}\n', 'bosun.meta': 'source=git\nrepo=https://github.com/o/r\nbranch=main\nfile=deploy/compose.yaml\nupdated=x\n' });
    expect(JSON.parse(run('stack_get.sh', { name: 'g' }).stdout)).toMatchObject({ source: 'git', repo: 'https://github.com/o/r', yaml: 'services: {}\n', env: '' });
    // a compose file that is a link out of the checkout is not read
    fs.rmSync(path.join(stackDir('g'), 'repo', 'deploy', 'compose.yaml'));
    try { fs.symlinkSync('/etc/hostname', path.join(stackDir('g'), 'repo', 'deploy', 'compose.yaml')); expect(JSON.parse(run('stack_get.sh', { name: 'g' }).stdout).yaml).toBe(''); } catch { /* no symlinks here */ }
    // external
    const ext = path.join(bin, 'ext.yaml'); fs.writeFileSync(ext, 'services: {x: {}}\n');
    fake(`case "$1" in compose) echo '[{"Name":"other","Status":"running(1)","ConfigFiles":"/nope"},{"Name":"ext","Status":"running(1)","ConfigFiles":"${sp(ext)},/more.yaml"}]' ;; ps) exit 0 ;; esac`);
    expect(JSON.parse(run('stack_get.sh', { name: 'ext' }).stdout)).toEqual({ name: 'ext', source: 'external', repo: '', branch: '', file: '', yaml: 'services: {x: {}}\n', env: '' });
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
});
