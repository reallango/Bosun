import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { buildScriptInvocation, parseStateOutput, parseScriptOutput } from './runtime/script-run';

// These run the package's Linux scripts against fake `curl`, `docker`, `systemctl` and `sudo` programs placed first on the
// PATH. That needs a real POSIX shell (Linux, as in the Docker build), not Git Bash on Windows.
const hasSh = process.platform !== 'win32' && spawnSync('sh', ['-c', 'exit 0']).status === 0;
const dir = path.join(process.cwd(), 'widgets', 'ollama', 'scripts');
const script = (name: string) => fs.readFileSync(path.join(dir, name), 'utf8');

let bin = '';
let log = '';
beforeEach(() => { bin = fs.mkdtempSync(path.join(os.tmpdir(), 'bosun-fake-')); log = path.join(bin, 'calls.log'); fs.writeFileSync(log, ''); });
afterEach(() => { fs.rmSync(bin, { recursive: true, force: true }); });

const fake = (name: string, body: string) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
const calls = () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
const run = (file: string, params: Record<string, string> = {}, extraEnv: Record<string, string> = {}) => {
  const inv = buildScriptInvocation('linux', script(file), params);
  return spawnSync('sh', ['-c', inv.command], { input: inv.stdin, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, LOG: log, ...extraEnv } });
};
const lastLine = (out: string) => out.split('\n').filter(Boolean).at(-1);

describe('the Ollama package', () => {
  it('holds a script file for every script its manifest names, and every file of the scripts folder is used', () => {
    // Ollama is an optional package (not in widgets/bundled.json), so it is read from its folder.
    const folder = path.join(process.cwd(), 'widgets', 'ollama');
    const files: Record<string, string> = {};
    for (const f of fs.readdirSync(path.join(folder, 'scripts'))) files[`scripts/${f}`] = fs.readFileSync(path.join(folder, 'scripts', f), 'utf8');
    const pkg = { manifest: JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json'), 'utf8')) as { widgets: { spec?: { scripts?: Record<string, { linux?: string; windows?: string }> } }[] }, files };
    const named = new Set<string>();
    for (const s of Object.values(pkg!.manifest.widgets[0].spec?.scripts ?? {})) { if (s.linux) named.add(s.linux); if (s.windows) named.add(s.windows); }
    for (const f of Array.from(named)) expect(pkg!.files[f], f).toBeTruthy();
    for (const f of Object.keys(pkg!.files)) expect(named.has(f), `${f} is not used by any script`).toBe(true);
  });
});

describe('Ollama status script (Linux)', () => {
  it.skipIf(!hasSh)('wraps what the API says, and says when it is down', () => {
    fake('curl', `case "$*" in
*api/version*) echo '{"version":"0.5.1"}' ;;
*api/tags*) echo '{"models":[{"name":"llama3:8b","size":4700000000,"details":{"parameter_size":"8B"}}]}' ;;
*api/ps*) echo '{"models":[{"name":"llama3:8b","size":5000000000,"size_vram":4000000000}]}' ;;
esac`);
    const j = JSON.parse(run('status.sh').stdout);
    expect(j.version).toBe('0.5.1');
    expect(j.tags.models[0].name).toBe('llama3:8b');
    expect(j.ps.models[0].size_vram).toBe(4000000000);
    fake('curl', 'exit 7');
    expect(JSON.parse(run('status.sh').stdout)).toEqual({ down: true });
  });

  it.skipIf(!hasSh)('adds what `ollama ps` shows to every loaded model: the share on CPU and GPU, and the short id', () => {
    const digest = 'a80c4f17acd55265feec403c7aef86be0c25983ab279d83f3bcd3abbcb5b8b72';
    const ps = JSON.stringify({ models: [
      { name: 'gpu:1b', model: 'gpu:1b', size: 1000, digest, details: { parameter_size: '1B' }, expires_at: '2030-01-01T00:00:00Z', size_vram: 1000, context_length: 4096 },
      { name: 'cpu:7b', model: 'cpu:7b', size: 2000, digest, size_vram: 0 },
      { name: 'split:8b', model: 'split:8b', size: 5000, digest, size_vram: 2600 },
    ] });
    fake('curl', `case "$*" in
*api/version*) echo '{"version":"0.5.1"}' ;;
*api/tags*) echo '{"models":[]}' ;;
*api/ps*) echo '${ps}' ;;
esac`);
    const m = JSON.parse(run('status.sh').stdout).ps.models;
    expect(m.map((x: { processor: string }) => x.processor)).toEqual(['100% GPU', '100% CPU', '48%/52% CPU/GPU']);
    expect(m.every((x: { id: string }) => x.id === 'a80c4f17acd5')).toBe(true);
    expect(m[0]).toMatchObject({ name: 'gpu:1b', size: 1000, size_vram: 1000, context_length: 4096, expires_at: '2030-01-01T00:00:00Z', details: { parameter_size: '1B' } });
    // nothing loaded stays as it was
    fake('curl', `case "$*" in *api/version*) echo '{"version":"0.5.1"}' ;; *api/tags*) echo '{"models":[]}' ;; *api/ps*) echo '{"models":[]}' ;; esac`);
    expect(JSON.parse(run('status.sh').stdout).ps).toEqual({ models: [] });
  });
});

describe('Ollama detect script (Linux)', () => {
  const state = (out: string) => parseStateOutput(out, {
    'install.kind': 'string', 'install.manager': 'string', 'install.name': 'string', 'install.state': 'string', 'install.start_mode': 'string',
    'install.container': 'string', 'install.image': 'string', 'install.restart_policy': 'string', 'install.docker_available': 'boolean',
    'env.ollama_context_length': 'string', 'env.ollama_max_loaded_models': 'string',
  }) as { install: Record<string, unknown>; env: Record<string, string> };

  const dockerFake = (insp: string) => fake('docker', `case "$1" in
ps) if [ "$2" = "-a" ]; then echo 'ollama ollama/ollama:0.5.1'; fi ;;
inspect) case "$*" in
*State.Status*) echo running ;;
*RestartPolicy.Name*) echo unless-stopped ;;
*Config.Image*) echo ollama/ollama:0.5.1 ;;
*Config.Env*) printf '%s\\n' ${insp} ;;
esac ;;
esac`);

  it.skipIf(!hasSh)('a container: its name, image, state, restart policy and the settings (whole numbers only)', () => {
    fake('curl', 'echo \'{"version":"0.5.1"}\'');
    dockerFake("'PATH=/usr/bin' 'OLLAMA_CONTEXT_LENGTH=16384' 'OLLAMA_MAX_LOADED_MODELS=abc'");
    const s = state(run('detect.sh').stdout);
    expect(s.install).toMatchObject({ kind: 'docker', container: 'ollama', image: 'ollama/ollama:0.5.1', state: 'running', restart_policy: 'unless-stopped', docker_available: true });
    expect(s.env.ollama_context_length).toBe('16384');
    expect(s.env.ollama_max_loaded_models ?? '').toBe('');
  });

  it.skipIf(!hasSh)('a systemd service', () => {
    fake('curl', 'echo \'{"version":"0.5.1"}\'');
    fake('systemctl', `case "$*" in
*LoadState*) echo loaded ;;
*is-active*) echo active ;;
*is-enabled*) echo enabled ;;
*Environment*) echo 'Environment="OLLAMA_HOST=0.0.0.0:11434" "OLLAMA_CONTEXT_LENGTH=8192"' ;;
esac`);
    const s = state(run('detect.sh').stdout);
    expect(s.install).toMatchObject({ kind: 'service', manager: 'systemd', name: 'ollama', state: 'running', start_mode: 'enabled', docker_available: false });
    expect(s.env.ollama_context_length).toBe('8192');
  });

  it.skipIf(!hasSh)('a standard install (a binary, no service) and no install at all', () => {
    fake('curl', 'exit 7');
    fake('ollama', 'exit 0');
    expect(state(run('detect.sh').stdout).install.kind).toBe('standard');
    fs.rmSync(path.join(bin, 'ollama'));
    // nothing named ollama on the PATH of the fake folder, but the real PATH may have one: only assert when it has not
    if (spawnSync('sh', ['-c', 'command -v ollama'], { env: { ...process.env, PATH: process.env.PATH } }).status !== 0) {
      expect(state(run('detect.sh').stdout).install.kind).toBe('none');
    }
  });
});

describe('Ollama container recreate script (Linux)', () => {
  // A fake docker that answers `inspect -f <template>` from a table and records every other call.
  const dockerFor = (table: Record<string, string>) => {
    const cases = Object.entries(table).map(([key, value]) => `*'${key}'*) printf '%s' '${value.replace(/'/g, `'\\''`)}' ;;`).join('\n');
    fake('docker', `case "$1" in
ps) exit 0 ;;
info) exit 0 ;;
inspect) if [ "$2" = "-f" ]; then case "$3" in
${cases}
esac; fi ;;
*) echo "docker $*" >> "$LOG" ;;
esac`);
  };
  const base: Record<string, string> = {
    'compose.project': '',
    'Config.Image}}': 'ollama/ollama:0.5.1',
    'RestartPolicy.Name': 'unless-stopped',
    'MaximumRetryCount': '0',
    'NetworkMode': 'bridge',
    'PortBindings': '|11434|11434/tcp\n127.0.0.1|9000|9000/tcp\n',
    '.Mounts': 'volume|ollama||/root/.ollama|true\nbind||/srv/models|/models|false\n',
    'Config.Env': 'PATH=/usr/bin\nOLLAMA_HOST=0.0.0.0\nOLLAMA_CONTEXT_LENGTH=4096\nNVIDIA_VISIBLE_DEVICES=all\nOTHER=secret\n',
    'DeviceRequests': '-1||[[gpu]]\n',
  };
  const runLine = () => calls().find(c => c.startsWith('docker run')) ?? '';

  it.skipIf(!hasSh)('rebuilds the container with a new image: same name, ports, volumes, environment, GPU and restart policy', () => {
    dockerFor(base);
    fake('curl', 'echo \'{"version":"0.6.0"}\'');
    const r = run('dk_recreate.sh', { container: 'ollama', version: '0.6.0', setting: 'none', value: 'default' });
    expect(lastLine(r.stdout)).toMatch(/^DONE Ollama 0.6.0 is running/);
    const line = runLine();
    expect(line).toContain('--name ollama');
    expect(line).toContain('--restart unless-stopped');
    expect(line).toContain('-p 11434:11434/tcp');
    expect(line).toContain('-p 127.0.0.1:9000:9000/tcp');
    expect(line).toContain('-v ollama:/root/.ollama');
    expect(line).toContain('-v /srv/models:/models:ro');
    expect(line).toContain('-e OLLAMA_HOST=0.0.0.0');
    expect(line).toContain('-e OLLAMA_CONTEXT_LENGTH=4096');
    expect(line).toContain('-e NVIDIA_VISIBLE_DEVICES=all');
    expect(line).not.toContain('OTHER=secret');     // only the Ollama and NVIDIA variables are carried over
    expect(line).toContain('--gpus all');
    expect(line.endsWith('ollama/ollama:0.6.0')).toBe(true);
    expect(calls().some(c => c.startsWith('docker pull ollama/ollama:0.6.0'))).toBe(true);
    expect(calls().some(c => c.startsWith('docker rename ollama ollama-bosun-old'))).toBe(true);
    expect(calls().some(c => c.startsWith('docker rm ollama-bosun-old'))).toBe(true);
  });

  it.skipIf(!hasSh)('changes one setting from the image it already has: nothing is pulled, the value is replaced, "default" removes it', () => {
    dockerFor(base);
    fake('curl', 'echo \'{"version":"0.5.1"}\'');
    run('dk_recreate.sh', { container: 'ollama', version: 'keep', setting: 'OLLAMA_CONTEXT_LENGTH', value: '16384' });
    expect(calls().some(c => c.startsWith('docker pull'))).toBe(false);
    expect(runLine()).toContain('-e OLLAMA_CONTEXT_LENGTH=16384');
    expect(runLine()).not.toContain('OLLAMA_CONTEXT_LENGTH=4096');
    expect(runLine().endsWith('ollama/ollama:0.5.1')).toBe(true);
    fs.writeFileSync(log, '');
    run('dk_recreate.sh', { container: 'ollama', version: 'keep', setting: 'OLLAMA_CONTEXT_LENGTH', value: 'default' });
    expect(runLine()).not.toContain('OLLAMA_CONTEXT_LENGTH');
  });

  it.skipIf(!hasSh)('refuses a Compose container', () => {
    dockerFor({ ...base, 'compose.project': 'stack' });
    const r = run('dk_recreate.sh', { container: 'ollama', version: 'latest', setting: 'none', value: 'default' });
    expect(parseScriptOutput(r.stdout).error).toMatch(/Docker Compose/);
    expect(calls().some(c => c.startsWith('docker run'))).toBe(false);
  });

  it.skipIf(!hasSh)('puts the old container back when the new one fails to start', () => {
    dockerFor(base);
    fake('docker', `case "$1" in
ps|info) exit 0 ;;
inspect) if [ "$2" = "-f" ]; then case "$3" in *Config.Image*) printf '%s' ollama/ollama:0.5.1 ;; *compose*) ;; *RestartPolicy.Name*) printf unless-stopped ;; esac; fi ;;
run) echo "docker $*" >> "$LOG"; exit 125 ;;
*) echo "docker $*" >> "$LOG" ;;
esac`);
    const r = run('dk_recreate.sh', { container: 'ollama', version: 'latest', setting: 'none', value: 'default' });
    expect(parseScriptOutput(r.stdout).error).toMatch(/put back/);
    expect(calls().some(c => c.startsWith('docker rename ollama-bosun-old ollama'))).toBe(true);
    expect(calls().some(c => c.startsWith('docker start ollama'))).toBe(true);
  });
});

describe('Ollama systemd scripts (Linux)', () => {
  const sudoFake = () => {
    // sudo -n <cmd>: runs mkdir/test/cat on a mapped folder, records install and systemctl calls
    fake('sudo', `shift
[ "$1" = "-n" ] && shift
case "$1" in
true) exit 0 ;;
mkdir) mkdir -p "$ROOT$3" ;;
test) [ -f "$ROOT$3" ] ;;
cat) cat "$ROOT$2" ;;
install) cp "$4" "$ROOT$5" ;;
systemctl) echo "systemctl $2 $3" >> "$LOG" ;;
esac`);
    fake('systemctl', 'echo active');
  };

  it.skipIf(!hasSh)('writes the setting into a drop-in that keeps the other managed settings, then restarts the unit', () => {
    sudoFake();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bosun-root-'));
    try {
      const target = path.join(root, 'etc/systemd/system/ollama.service.d');
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, 'zz-bosun-settings.conf'), '[Service]\nEnvironment="OLLAMA_MAX_LOADED_MODELS=2"\nEnvironment="OLLAMA_CONTEXT_LENGTH=1000"\n');
      const r = run('sd_setting.sh', { unit: 'ollama', setting: 'OLLAMA_CONTEXT_LENGTH', value: '16384' }, { ROOT: root });
      expect(lastLine(r.stdout)).toMatch(/^DONE Applied and restarted: OLLAMA_CONTEXT_LENGTH = 16384/);
      const conf = fs.readFileSync(path.join(target, 'zz-bosun-settings.conf'), 'utf8');
      expect(conf).toContain('[Service]');
      expect(conf).toContain('Environment="OLLAMA_MAX_LOADED_MODELS=2"');
      expect(conf).toContain('Environment="OLLAMA_CONTEXT_LENGTH=16384"');
      expect(conf).not.toContain('=1000');
      expect(calls()).toEqual(['systemctl daemon-reload ', 'systemctl restart ollama']);
      run('sd_setting.sh', { unit: 'ollama', setting: 'OLLAMA_MAX_LOADED_MODELS', value: 'default' }, { ROOT: root });
      expect(fs.readFileSync(path.join(target, 'zz-bosun-settings.conf'), 'utf8')).not.toContain('OLLAMA_MAX_LOADED_MODELS');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it.skipIf(!hasSh)('needs passwordless sudo and says so', () => {
    fake('sudo', 'exit 1');
    expect(parseScriptOutput(run('sd_setting.sh', { unit: 'ollama', setting: 'OLLAMA_CONTEXT_LENGTH', value: '1' }).stdout).error).toMatch(/passwordless sudo/);
    expect(parseScriptOutput(run('sd_control.sh', { unit: 'ollama', op: 'restart' }).stdout).error).toMatch(/passwordless sudo/);
  });

  it.skipIf(!hasSh)('control reports the state after the operation', () => {
    sudoFake();
    const r = run('sd_control.sh', { unit: 'ollama', op: 'restart' });
    expect(lastLine(r.stdout)).toBe('DONE restart: active');
    expect(calls()).toContain('systemctl restart ollama');
  });
});

describe('Ollama pull and delete scripts (Linux)', () => {
  it.skipIf(!hasSh)('turns the streamed pull into steps and progress, and ends with DONE', () => {
    fake('curl', `printf '%s\\n' '{"status":"pulling manifest"}' '{"status":"pulling abc123","digest":"sha256:abc","total":1000,"completed":250}' '{"status":"pulling abc123","digest":"sha256:abc","total":1000,"completed":900}' '{"status":"pulling def456","total":50,"completed":50}' '{"status":"verifying sha256 digest"}' '{"status":"writing manifest"}' '{"status":"success"}'`);
    const out = parseScriptOutput(run('pull.sh', { model: 'llama3.2:1b' }).stdout);
    expect(out.steps[0]).toBe('Pulling llama3.2:1b');
    expect(out.steps).toContain('verifying sha256 digest');
    expect(out.steps.filter(s => s.startsWith('pulling')).length).toBe(1);   // the manifest and every layer are one step: "pulling"
    expect(out.progress).toEqual({ done: 100, total: 100, percent: 100 });
    expect(out.done).toBe('Pulled llama3.2:1b');
    expect(out.error).toBeNull();
  });

  it.skipIf(!hasSh)('reports the API error of a failed pull', () => {
    fake('curl', `echo '{"error":"pull model manifest: file does not exist"}'`);
    expect(parseScriptOutput(run('pull.sh', { model: 'nope:1' }).stdout).error).toBe('pull model manifest: file does not exist');
  });

  it.skipIf(!hasSh)('sends the model as data in the request body (a value with shell characters stays a value)', () => {
    fake('curl', `printf '%s\\n' "$*" >> "$LOG"; echo '{"status":"success"}'`);
    run('pull.sh', { model: 'a/b:c' });
    expect(calls().join('\n')).toContain('{"name":"a/b:c","stream":true}');
  });

  it.skipIf(!hasSh)('delete: DONE on 200, the API message on an error, a clear message when Ollama is down', () => {
    fake('curl', `printf '\\nHTTP_STATUS=200\\n'`);
    expect(parseScriptOutput(run('delete.sh', { model: 'x:1' }).stdout).done).toBe('Deleted x:1');
    fake('curl', `printf '{"error":"model not found"}\\nHTTP_STATUS=404\\n'`);
    expect(parseScriptOutput(run('delete.sh', { model: 'x:1' }).stdout).error).toBe('model not found');
    fake('curl', `printf '\\nHTTP_STATUS=000\\n'`);
    expect(parseScriptOutput(run('delete.sh', { model: 'x:1' }).stdout).error).toMatch(/not reachable/);
  });
});

describe('Ollama Windows scripts', () => {
  const files = ['detect.ps1', 'status.ps1', 'pull.ps1', 'delete.ps1', 'win_control.ps1', 'win_startup.ps1', 'win_setting.ps1', 'win_install.ps1'];
  it('exist, are plain ASCII (PowerShell 5.1 reads a BOM-less file as ANSI) and never restart the host', () => {
    for (const f of files) {
      const text = script(f);
      // eslint-disable-next-line no-control-regex
      expect(/[^\x00-\x7f]/.test(text), f).toBe(false);
      expect(text, f).not.toMatch(/Restart-Computer/);
    }
  });
  it('read their parameters from the environment, not from their own text', () => {
    for (const f of ['pull.ps1', 'delete.ps1', 'win_control.ps1', 'win_startup.ps1', 'win_setting.ps1', 'win_install.ps1']) expect(script(f), f).toContain('$env:BOSUN_PARAM_');
  });
  it('the install checks the download against the published SHA-256', () => {
    expect(script('win_install.ps1')).toContain('SHA256');
  });
});
