import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { buildScriptInvocation, parseScriptOutput } from './runtime/script-run';

// The Docker package's Linux scripts against a fake `docker` placed first on the PATH (a real POSIX shell is needed: Linux,
// as in the Docker build, not Git Bash on Windows). The real `docker inspect` templates are exercised against real
// containers in the integration check; here the decision logic of the shell check is tested with the lines the templates print.
const hasSh = process.platform !== 'win32' && spawnSync('sh', ['-c', 'exit 0']).status === 0;
const dir = path.join(process.cwd(), 'widgets', 'docker', 'scripts');
const script = (name: string) => fs.readFileSync(path.join(dir, name), 'utf8');

let bin = '';
let log = '';
beforeEach(() => { bin = fs.mkdtempSync(path.join(os.tmpdir(), 'bosun-fakedk-')); log = path.join(bin, 'calls.log'); fs.writeFileSync(log, ''); });
afterEach(() => { fs.rmSync(bin, { recursive: true, force: true }); });

const fake = (body: string) => fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
const calls = () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
const run = (file: string, params: Record<string, string> = {}) => {
  const inv = buildScriptInvocation('linux', script(file), params);
  return spawnSync('sh', ['-c', inv.command], { input: inv.stdin, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, LOG: log } });
};

const ID = 'a'.repeat(64);
/** A fake docker whose `inspect --format` answers with the given facts (what the real template prints). */
const inspecting = (facts: string) => {
  fs.writeFileSync(path.join(bin, 'facts.txt'), `${facts}\n`);
  fake(`case "$1" in\nps) exit 0 ;;\ninspect) cat "${path.join(bin, 'facts.txt')}" ;;\nesac`);
};

describe('Docker package scripts', () => {
  it.skipIf(!hasSh)('ps lists containers as JSON lines, and says when Docker cannot be used', () => {
    fake(`case "$1" in ps) if [ "$2" = "-a" ]; then echo '{"Names":"web","State":"running"}'; fi ;; esac`);
    expect(run('ps.sh').stdout.trim()).toBe('{"Names":"web","State":"running"}');
    fake('exit 1');
    const r = run('ps.sh');
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/Docker is not available/);
  });

  it('ps prints only the listed fields, never the start command, labels or mounts (they can hold secrets)', () => {
    const fmt = script('ps.sh').match(/--format '([^']*)'/)?.[1] ?? '';
    expect(fmt).not.toBe('');
    expect(fmt).not.toMatch(/\{\{\s*json\s+\.\s*\}\}/);
    const fields = Array.from(fmt.matchAll(/\{\{json \.(\w+)/g), m => m[1]);
    expect(fields.length).toBeGreaterThan(0);
    for (const f of fields) expect(['ID', 'Names', 'Image', 'State', 'Status', 'Ports', 'CreatedAt', 'RunningFor']).toContain(f);
    expect(fmt).not.toMatch(/Command|Labels|Mounts|Networks/);
    // Only the compose project and service labels, by name.
    expect(Array.from(fmt.matchAll(/\.Label "([^"]+)"/g), m => m[1])).toEqual(['com.docker.compose.project', 'com.docker.compose.service']);
  });

  it.skipIf(!hasSh)('logs asks for the number of lines of the named container', () => {
    fake(`case "$1" in ps) exit 0 ;; logs) echo "docker $*" >> "$LOG"; echo hello ;; esac`);
    const r = run('logs.sh', { name: 'web-1', lines: '50' });
    expect(r.stdout).toContain('hello');
    expect(calls()).toEqual(['docker logs --tail 50 web-1']);
  });

  it.skipIf(!hasSh)('summary counts the containers, the errors, the health share and the average uptime', () => {
    fake(`case "$1" in
ps) if [ "$2" = "-a" ]; then case "$*" in *.Image*) exit 0 ;; esac; printf '%s\\n' 'id1|running|Up 3 hours (healthy)|shop' 'id2|running|Up 2 hours (unhealthy)|shop' 'id3|exited|Exited (0) 2 hours ago|' 'id4|exited|Exited (137) 5 minutes ago|' 'id5|restarting|Restarting (1) 10 seconds ago|'; exit 0; fi; [ "$2" = "-q" ] && echo id1; exit 0 ;;
version) echo 27.1.1 ;;
inspect) case "$*" in *StartedAt*) echo 2020-01-01T00:00:00Z ;; esac ;;
image) exit 0 ;;
buildx) exit 1 ;;
esac`);
    const lines = Object.fromEntries(run('summary.sh').stdout.trim().split('\n').map(l => {
      const i = l.indexOf('=');
      return [l.slice(0, i), l.slice(i + 1)];
    }));
    expect(lines['docker.version']).toBe('27.1.1');
    expect(lines['docker.total']).toBe('5');
    expect(lines['docker.running']).toBe('2');
    expect(lines['docker.split']).toBe('2 running · 3 stopped');
    expect(lines['docker.errors']).toBe('3');
    expect(lines['docker.healthy']).toBe('1');
    expect(lines['docker.health_total']).toBe('2');
    expect(Number(lines['docker.avg_uptime'])).toBeGreaterThan(0);
  });

  it.skipIf(!hasSh)('control runs the operation it was given and reports a failure with Docker\'s own message', () => {
    fake(`case "$1" in ps) exit 0 ;; restart) echo "docker $*" >> "$LOG" ;; stop) echo "Error: No such container: x" >&2; exit 1 ;; esac`);
    expect(parseScriptOutput(run('control.sh', { name: 'web', op: 'restart' }).stdout).done).toBe('restart: web');
    expect(calls()).toEqual(['docker restart web']);
    expect(parseScriptOutput(run('control.sh', { name: 'x', op: 'stop' }).stdout).error).toMatch(/No such container/);
  });
});

describe('Docker shell check (the rules for giving an API key a shell)', () => {
  const check = (facts: string) => {
    inspecting(facts);
    return parseScriptOutput(run('shell_check.sh', { ref: 'web' }).stdout);
  };
  const base = `ID ${ID}`;

  it.skipIf(!hasSh)('allows an ordinary container and pins the exact id', () => {
    const r = run('shell_check.sh', { ref: 'web' });   // (nothing faked yet: docker is not available)
    expect(parseScriptOutput(r.stdout).error).toBeTruthy();
    inspecting(`${base}\nMOUNT /srv/app\nBIND /srv/app:/data\nCAP NET_ADMIN`);
    const ok = run('shell_check.sh', { ref: 'web' });
    expect(ok.stdout).toContain(`REF ${ID}`);
    expect(parseScriptOutput(ok.stdout)).toMatchObject({ done: 'ok', error: null });
  });

  it.skipIf(!hasSh)('refuses what reaches the host', () => {
    const cases: [string, RegExp][] = [
      [`${base}\nRISK it is privileged`, /privileged/],
      [`${base}\nRISK it shares the host (or another container) PID namespace`, /PID namespace/],
      [`${base}\nRISK it is not running`, /not running/],
      [`${base}\nRISK it has host devices attached`, /devices/],
      [`${base}\nCAP SYS_ADMIN`, /dangerous capabilities \(SYS_ADMIN\)/],
      [`${base}\nCAP cap_sys_ptrace\nCAP ALL`, /SYS_PTRACE, ALL/],
      [`${base}\nSEC seccomp=unconfined`, /security profile is disabled/],
      [`${base}\nSEC label:disable`, /security profile is disabled/],
      [`${base}\nMOUNT /var/run/docker.sock`, /host path \/var\/run\/docker.sock/],
      [`${base}\nMOUNT /`, /host path \//],
      [`${base}\nMOUNT /etc/ssh`, /host path \/etc\/ssh/],
      [`${base}\nMOUNT /srv/../etc`, /host path \/srv\/..\/etc/],          // resolved before it is compared
      [`${base}\nBIND /home/user/.ssh:/root/.ssh:ro`, /host path \/home\/user\/.ssh/],
      [`${base}\nBIND /opt/run/containerd.sock:/x`, /containerd.sock/],
    ];
    for (const [facts, why] of cases) {
      const r = check(facts);
      expect(r.error, facts).toMatch(why);
      expect(r.done, facts).toBeNull();
    }
  });

  it.skipIf(!hasSh)('allows paths that merely look like sensitive ones, and named volumes', () => {
    expect(check(`${base}\nMOUNT /srv/etc\nMOUNT /homes/shared\nMOUNT /usrlocal\nBIND /data:/data`).error).toBeNull();
    expect(check(`${base}\nBIND named-volume:/data`).error).toBeNull();
  });

  it.skipIf(!hasSh)('reports every reason at once, once each', () => {
    const r = check(`${base}\nRISK it is privileged\nRISK it is privileged\nMOUNT /etc\nCAP SYS_ADMIN`);
    expect(r.error).toBe('container shell refused: it is privileged; it mounts the host path /etc; it has dangerous capabilities (SYS_ADMIN)');
  });

  it.skipIf(!hasSh)('never treats an unreadable inspection as safe', () => {
    expect(check('').error).toMatch(/unreadable container id/);
    expect(check('ID not-a-container-id').error).toMatch(/unreadable container id/);
    expect(check(`ID ${'g'.repeat(64)}`).error).toMatch(/unreadable container id/);
    fake(`case "$1" in ps) exit 0 ;; inspect) exit 1 ;; esac`);
    expect(parseScriptOutput(run('shell_check.sh', { ref: 'gone' }).stdout).error).toMatch(/not found or could not be inspected/);
    fake('exit 1');
    expect(parseScriptOutput(run('shell_check.sh', { ref: 'web' }).stdout).error).toMatch(/Docker is not available/);
  });
});
