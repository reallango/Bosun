import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { buildScriptInvocation } from './runtime/script-run';

const dir = path.join(process.cwd(), 'widgets', 'updates', 'scripts');
const read = (name: string) => fs.readFileSync(path.join(dir, name), 'utf8');
// These run fake package managers from a temporary folder on the PATH: that needs a real POSIX shell (Linux, as in the
// Docker build), not Git Bash on Windows, where a Windows temp path cannot be put in PATH.
const hasSh = process.platform !== 'win32' && spawnSync('sh', ['-c', 'exit 0']).status === 0;
const hasAwk = hasSh && spawnSync('sh', ['-c', 'command -v awk >/dev/null 2>&1']).status === 0;

/** Runs a script with a folder of fake package managers first on the PATH. */
function runWith(bin: string, script: string, env: Record<string, string> = {}) {
  const inv = buildScriptInvocation('linux', script, {});
  const shell = spawnSync('sh', ['-c', 'command -v sh'], { encoding: 'utf8' }).stdout.trim() || 'sh';
  const withPath = `PATH='${bin.replace(/\\/g, '/')}':"$PATH" ${inv.command}`;
  return spawnSync(shell, ['-c', withPath], { input: inv.stdin, encoding: 'utf8', env: { ...process.env, ...env } });
}

describe('OS Update Check, Linux check script', () => {
  let bin = '';
  beforeAll(() => { bin = fs.mkdtempSync(path.join(os.tmpdir(), 'bosun-fakepm-')); });
  afterAll(() => { fs.rmSync(bin, { recursive: true, force: true }); });
  const fake = (name: string, body: string) => { fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 }); };
  const clear = () => { for (const f of fs.readdirSync(bin)) fs.rmSync(path.join(bin, f)); };

  it.skipIf(!hasAwk)('reads apt: versions, the security origin, counts and the packages', () => {
    clear();
    fake('apt-get', `cat <<'EOF'
Reading package lists...
Inst openssl [3.0.13-0ubuntu3.4] (3.0.13-0ubuntu3.5 Ubuntu:24.04/noble-security [amd64])
Inst curl [8.5.0-2ubuntu10.4] (8.5.0-2ubuntu10.5 Ubuntu:24.04/noble-updates [amd64])
Inst newpkg (1.0 Ubuntu:24.04/noble [amd64])
Conf openssl (3.0.13-0ubuntu3.5 Ubuntu:24.04/noble-security [amd64])
EOF`);
    const r = runWith(bin, read('check.sh'));
    expect(r.status).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j).toMatchObject({ manager: 'apt', updatesAvailable: 3, securityUpdates: 1 });
    expect(j.packages[0]).toEqual({ name: 'openssl', current_version: '3.0.13-0ubuntu3.4', new_version: '3.0.13-0ubuntu3.5', is_security: true });
    expect(j.packages[1]).toEqual({ name: 'curl', current_version: '8.5.0-2ubuntu10.4', new_version: '8.5.0-2ubuntu10.5', is_security: false });
    expect(j.packages[2]).toEqual({ name: 'newpkg', current_version: '', new_version: '1.0', is_security: false });
  });

  it.skipIf(!hasAwk)('reads dnf check-update output', () => {
    clear();
    fake('dnf', `printf 'kernel.x86_64  6.8.1-1.fc40  updates\\nopenssl.x86_64  3.2.1-2.fc40  updates-security\\n'`);
    const j = JSON.parse(runWith(bin, read('check.sh')).stdout);
    expect(j).toMatchObject({ manager: 'dnf', updatesAvailable: 2, securityUpdates: 1, rebootRequired: false });
    expect(j.packages[0]).toEqual({ name: 'kernel.x86_64', current_version: '', new_version: '6.8.1-1.fc40', is_security: false });
  });

  it.skipIf(!hasAwk)('says so when nothing is pending, and reports no package manager when there is none', () => {
    clear();
    fake('apt-get', 'echo "Reading package lists..."');
    expect(JSON.parse(runWith(bin, read('check.sh')).stdout)).toMatchObject({ manager: 'apt', updatesAvailable: 0, securityUpdates: 0, packages: [] });
  });

  it.skipIf(!hasAwk)('always prints valid JSON, even for package names with odd characters, and caps the list at 200', () => {
    clear();
    const lines = Array.from({ length: 250 }, (_, i) => `Inst pkg${i}+x [1:2.${i}~rc1] (1:3.${i} Debian:12/stable-security [amd64])`).join('\\n');
    fake('apt-get', `printf '${lines}\\n'`);
    const j = JSON.parse(runWith(bin, read('check.sh')).stdout);
    expect(j.updatesAvailable).toBe(250);
    expect(j.packages).toHaveLength(200);
    expect(j.packages[3].name).toBe('pkg3+x');
  });
});

describe('OS Update Check, Linux install script', () => {
  const lines = (out: string) => out.split('\n').filter(Boolean);
  let bin = '';
  beforeAll(() => { bin = fs.mkdtempSync(path.join(os.tmpdir(), 'bosun-fakepm-')); });
  afterAll(() => { fs.rmSync(bin, { recursive: true, force: true }); });
  const fake = (name: string, body: string) => { fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 }); };
  const clear = () => { for (const f of fs.readdirSync(bin)) fs.rmSync(path.join(bin, f)); };

  it.skipIf(!hasSh)('reports progress per package it sets up, and DONE when apt succeeds', () => {
    clear();
    fake('sudo', 'shift; [ "$1" = "-n" ] && shift; exec "$@"');   // fake sudo -n
    fake('env', 'shift; exec "$@"');
    fake('apt-get', `case " $* " in *" -s "*) printf 'Inst a [1] (2 x)\\nInst b [1] (2 x)\\n';; *) printf 'Unpacking a\\nSetting up a (2) ...\\nSetting up b (2) ...\\n';; esac`);
    const out = lines(runWith(bin, read('install.sh')).stdout);
    expect(out[0]).toMatch(/^\[step\] Installing updates with apt/);
    expect(out).toContain('PROGRESS 1/2');
    expect(out).toContain('PROGRESS 2/2');
    expect(out.at(-1)).toMatch(/^DONE Updates installed/);
  });

  it.skipIf(!hasSh)('explains a missing passwordless sudo, and reports a failing install with its exit code', () => {
    clear();
    fake('sudo', 'echo "sudo: a password is required" >&2; exit 1');
    fake('apt-get', `printf 'Inst a [1] (2 x)\\n'`);
    expect(lines(runWith(bin, read('install.sh')).stdout).at(-1)).toBe('ERROR: Passwordless sudo is required for the SSH user');
    clear();
    fake('sudo', 'shift; [ "$1" = "-n" ] && shift; exec "$@"');
    fake('env', 'shift; exec "$@"');
    fake('apt-get', `case " $* " in *" -s "*) printf 'Inst a [1] (2 x)\\n';; *) echo "E: broken"; exit 100;; esac`);
    expect(lines(runWith(bin, read('install.sh')).stdout).at(-1)).toBe('ERROR: Update failed (exit 100)');
  });

  it.skipIf(!hasSh)('says so when there is no supported package manager', () => {
    clear();
    const only = fs.mkdtempSync(path.join(os.tmpdir(), 'bosun-nopm-'));
    try {
      const inv = buildScriptInvocation('linux', read('install.sh'), {});
      // a PATH with only the tools the runner needs, and no package manager
      const r = spawnSync('sh', ['-c', inv.command.replace(/^/, `PATH=${only}:/usr/bin:/bin `)], { input: inv.stdin, encoding: 'utf8' });
      const has = ['apt-get', 'dnf', 'yum'].some(b => spawnSync('sh', ['-c', `command -v ${b}`], { env: { ...process.env, PATH: '/usr/bin:/bin' } }).status === 0);
      if (!has) expect(lines(r.stdout).at(-1)).toMatch(/^ERROR: No supported package manager/);
    } finally { fs.rmSync(only, { recursive: true, force: true }); }
  });
});

describe('OS Update Check, Windows scripts', () => {
  const check = read('check.ps1');
  const install = read('install.ps1');

  it('the check reads the reboot-pending state from the registry, never from the COM class a remote session is refused', () => {
    expect(check).not.toMatch(/New-Object -ComObject Microsoft.Update.SystemInfo/);
    expect(check).toContain('WindowsUpdate\\Auto Update\\RebootRequired');
    expect(check).toContain('Component Based Servicing\\RebootPending');
  });

  it('the check reports a failed search as an error, never as "up to date"', () => {
    expect(check).toMatch(/catch \{[\s\S]*\$result\.error/);
  });

  it('the install runs as a SYSTEM scheduled task (remote sessions are refused by the Update Agent) and never restarts the host', () => {
    expect(install).toContain("-UserId 'SYSTEM'");
    expect(install).toContain('Register-ScheduledTask');
    expect(install).not.toMatch(/Restart-Computer|shutdown(\.exe)?\s+\/r/i);
  });

  it('both are plain ASCII (PowerShell 5.1 reads a BOM-less file as ANSI)', () => {
    // eslint-disable-next-line no-control-regex
    for (const text of [check, install]) expect(/[^\x00-\x7f]/.test(text)).toBe(false);
  });
});
