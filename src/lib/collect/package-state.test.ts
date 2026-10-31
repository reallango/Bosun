import { describe, it, expect } from 'vitest';
import { collectorsFrom, isDue, runCollector, sectionFor } from './packages';
import { stateProbesFrom, isStateDue, runStateProbe, stateSectionFor, scriptSource, resolveArgs } from './package-state';

const files = JSON.stringify({ 'scripts/probe.sh': 'echo "svc.up=true"\n', 'scripts/probe.ps1': 'Write-Output "svc.up=true"\n', 'scripts/run.sh': 'echo "{}"\n', 'scripts/run.ps1': 'Write-Output "{}"\n' });
const spec = (extra: Record<string, unknown> = {}) => JSON.stringify({
  version: 2,
  scripts: {
    probe: { as: 'service', timeoutSec: 30, linux: 'scripts/probe.sh', windows: 'scripts/probe.ps1', params: {} },
    run: { as: 'shell', timeoutSec: 20, linux: 'scripts/run.sh', windows: 'scripts/run.ps1', params: { command: { type: 'string', pattern: '^[a-z ]{1,20}$', maxLength: 20 }, count: { type: 'number', min: 1, max: 9, integer: true, default: 3 } } },
  },
  state: { script: 'probe', periodSec: 60, initialDelaySec: 120, fields: { 'svc.up': 'boolean', 'svc.version': 'string', 'svc.port': 'number' } },
  data: { source: 'command', as: 'shell', command: '', script: 'run', args: { command: 'config.command', count: 'config.count' }, cacheSecFrom: 'config.interval', cacheSec: 30, timeoutSec: 20, parse: 'json' },
  ...extra,
});
const row = (over: Record<string, unknown> = {}) => ({ type: 'demo', spec: spec(), files, widget_id: 'w1', config: JSON.stringify({ command: 'uptime', interval: 45 }), ...over });
const ok = (stdout: string, extra = {}) => async () => ({ stdout, stderr: '', exitCode: 0, timedOut: false, ...extra });

describe('script data collectors', () => {
  it('builds one collector per widget instance when settings feed the arguments, with the interval from the settings', () => {
    const c = collectorsFrom([row(), row({ widget_id: 'w2', config: JSON.stringify({ command: 'date', interval: 10 }) })]);
    expect(c.map(x => x.key)).toEqual(['demo#w1', 'demo#w2']);
    expect(c[0]).toMatchObject({ type: 'demo', instanceId: 'w1', as: 'shell', intervalMs: 45_000, timeoutMs: 20_000 });
    expect(c[1].intervalMs).toBe(10_000);
    expect(sectionFor('demo', 'w1')).toBe('pkg:demo#w1');
    expect(sectionFor('demo')).toBe('pkg:demo');
  });

  it('shares one collector per type when nothing comes from the settings', () => {
    const plain = spec({ data: { source: 'command', as: 'service', command: '', script: 'probe', parse: 'text', cacheSec: 30, timeoutSec: 10 } });
    expect(collectorsFrom([row({ spec: plain }), row({ spec: plain, widget_id: 'w2' })])).toHaveLength(1);
  });

  it('passes the instance settings as validated parameters and returns the shaped data', async () => {
    const c = collectorsFrom([row()])[0];
    let seen: { command: string; stdin?: string } = { command: '' };
    const r = await runCollector(c, 'linux', async (command: string, o: { stdin?: string }) => { seen = { command, stdin: o.stdin }; return { stdout: '{"a":1}', stderr: '', exitCode: 0 }; });
    expect(r).toEqual({ ok: true, data: { a: 1 } });
    expect(seen.command).toContain(`BOSUN_PARAM_command='uptime'`);
    expect(seen.command).toContain(`BOSUN_PARAM_count='3'`);      // the setting is not set: the default
    expect(seen.stdin).toBe('echo "{}"\n');
  });

  it('refuses a setting that breaks the parameter rules, without running anything', async () => {
    const c = collectorsFrom([row({ config: JSON.stringify({ command: 'rm -rf /; x', interval: 30 }) })])[0];
    let ran = false;
    const r = await runCollector(c, 'linux', async () => { ran = true; return { stdout: '', stderr: '', exitCode: 0 }; });
    expect(ran).toBe(false);
    expect(r).toEqual({ ok: false, error: 'command has an invalid format' });
  });

  it('wraps the script for powershell on Windows and reports a platform without a script', async () => {
    const c = collectorsFrom([row()])[0];
    let cmd = '';
    await runCollector(c, 'windows', async (command: string) => { cmd = command; return { stdout: '{}', stderr: '', exitCode: 0 }; });
    expect(cmd).toMatch(/^powershell\.exe .* -EncodedCommand /);
    const linuxOnly = spec({ scripts: { run: { as: 'shell', timeoutSec: 20, linux: 'scripts/run.sh', params: {} } }, data: { source: 'command', as: 'shell', command: '', script: 'run', parse: 'json', cacheSec: 30, timeoutSec: 20 } });
    const l = collectorsFrom([row({ spec: linuxOnly })])[0];
    expect(await runCollector(l, 'windows', ok(''))).toEqual({ ok: false, error: 'This widget is not available on Windows hosts' });
  });

  it('reports failures and timeouts', async () => {
    const c = collectorsFrom([row()])[0];
    expect(await runCollector(c, 'linux', ok('', { exitCode: 2, stderr: 'nope\n' }))).toEqual({ ok: false, error: 'nope' });
    expect(await runCollector(c, 'linux', ok('', { timedOut: true }))).toEqual({ ok: false, error: 'The script timed out' });
  });

  it('skips a package whose script file is missing', () => {
    expect(collectorsFrom([row({ files: '{}' })])).toEqual([]);
  });

  it('an initial delay holds the first run back, then the interval applies', () => {
    const c = { intervalMs: 60_000, initialDelayMs: 120_000 };
    expect(isDue(c, undefined, 1000, false, 1000)).toBe(false);
    expect(isDue(c, undefined, 1000, true, 1000)).toBe(false);          // even a forced poll waits for the first run
    expect(isDue(c, undefined, 121_000, false, 1000)).toBe(true);
    expect(isDue(c, 1000, 30_000, false, 1000)).toBe(false);
    expect(isDue(c, 1000, 61_000, false, 1000)).toBe(true);
    expect(isDue({ intervalMs: 5000 }, undefined, 0, false)).toBe(true);   // unchanged for the old collectors
  });
});

describe('state probes', () => {
  it('are built from the widgets of a host, once per type, with the script text of both platforms', () => {
    const p = stateProbesFrom([row(), row({ widget_id: 'w2' })]);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ type: 'demo', periodMs: 60_000, initialDelayMs: 120_000, timeoutMs: 30_000 });
    expect(p[0].script.texts.linux).toContain('svc.up');
    expect(p[0].script.texts.windows).toContain('Write-Output');
    expect(stateSectionFor('demo')).toBe('pkg:demo:state');
  });

  it('ignore widgets without a state, with a missing script, or whose script wants parameters', () => {
    expect(stateProbesFrom([row({ spec: spec({ state: undefined }) })])).toEqual([]);
    expect(stateProbesFrom([row({ files: '{}' })])).toEqual([]);
    expect(stateProbesFrom([row({ spec: spec({ state: { script: 'run', periodSec: 60, initialDelaySec: 0, fields: { a: 'string' } } }) })])).toEqual([]);
    expect(stateProbesFrom(undefined as never)).toEqual([]);
  });

  it('run on a schedule: the initial delay once, then the period, a forced poll runs a probe that has run before', () => {
    const p = stateProbesFrom([row()])[0];
    expect(isStateDue(p, undefined, 0, 100_000)).toBe(false);
    expect(isStateDue(p, undefined, 0, 120_000)).toBe(true);
    expect(isStateDue(p, 0, 0, 30_000, true)).toBe(true);
    expect(isStateDue(p, 0, 0, 30_000)).toBe(false);
    expect(isStateDue(p, 0, 0, 60_000)).toBe(true);
    const fast = { ...p, initialDelayMs: 0 };
    expect(isStateDue(fast, undefined, 5, 5)).toBe(true);
  });

  it('turn the output into the typed state object', async () => {
    const p = stateProbesFrom([row()])[0];
    let stdin: string | undefined;
    const r = await runStateProbe(p, 'linux', async (_c: string, o: { stdin?: string }) => { stdin = o.stdin; return { stdout: 'svc.up=true\nsvc.version=1.4\nsvc.port=8080\nignored=1\n', stderr: '', exitCode: 0 }; });
    expect(r).toEqual({ ok: true, data: { svc: { up: true, version: '1.4', port: 8080 } } });
    expect(stdin).toContain('svc.up=true');
  });

  it('report a failing, slow or unsupported probe', async () => {
    const p = stateProbesFrom([row()])[0];
    expect(await runStateProbe(p, 'linux', ok('', { exitCode: 1, stderr: 'broken' }))).toEqual({ ok: false, error: 'broken' });
    expect(await runStateProbe(p, 'linux', ok('', { timedOut: true }))).toEqual({ ok: false, error: 'The probe timed out' });
    expect(await runStateProbe(p, 'linux', async () => { throw new Error('connection lost'); })).toEqual({ ok: false, error: 'connection lost' });
    const winOnly = { ...p, script: { ...p.script, texts: { linux: null, windows: 'x' } } };
    expect((await runStateProbe(winOnly, 'linux', ok(''))).ok).toBe(false);
  });
});

describe('helpers', () => {
  it('scriptSource gives the text per platform and resolveArgs falls back to defaults', () => {
    const s = scriptSource(JSON.parse(spec()), 'run', files)!;
    expect(s.texts.linux).toBe('echo "{}"\n');
    expect(scriptSource(JSON.parse(spec()), 'nope', files)).toBeNull();
    expect(scriptSource(JSON.parse(spec()), 'run', 'not json')).toBeNull();
    expect(resolveArgs({ count: 'config.count', command: 'config.command' }, s.params, { command: 'x' })).toEqual({ count: 3, command: 'x' });
    expect(resolveArgs({ count: 'config.count' }, s.params, { count: '' })).toEqual({ count: 3 });
  });
});
