import { describe, it, expect } from 'vitest';
import { collectorsFrom, isDue, runCollector, sectionFor, metricsOf, snapshotTrackersFrom } from './packages';

const spec = (data: Record<string, unknown>) => ({ type: 'dk_w', spec: JSON.stringify({ data }) });
const base = { source: 'command', as: 'service', command: 'docker ps', parse: 'jsonlines', cacheSec: 10, timeoutSec: 20, permission: 'dk.view' };

describe('collectorsFrom', () => {
  it('keeps command-sourced widgets with their account, interval and timeout, and skips the rest', () => {
    const rows = [
      spec(base),
      { type: 'snap', spec: JSON.stringify({ data: { source: 'snapshot', section: 'docker' } }) },
      { type: 'bad_json', spec: '{nope' },
      { type: 'bad_as', spec: JSON.stringify({ data: { ...base, as: 'root' } }) },
      { type: 'no_cmd', spec: JSON.stringify({ data: { ...base, command: undefined } }) },
      { type: 'obj', spec: { data: { ...base, as: 'shell', cacheSec: 1, timeoutSec: 999, windowsCommand: 'Get-Date', path: 'items', map: { a: 'b' } } } },
    ];
    const c = collectorsFrom(rows);
    expect(c.map(x => x.type)).toEqual(['dk_w', 'obj']);
    expect(c[0]).toMatchObject({ as: 'service', command: 'docker ps', intervalMs: 10_000, timeoutMs: 20_000, windowsCommand: null });
    expect(c[1]).toMatchObject({ as: 'shell', intervalMs: 5_000, timeoutMs: 60_000, windowsCommand: 'Get-Date', path: 'items' });   // clamped
    expect(collectorsFrom(undefined as any)).toEqual([]);
  });

  it('names the stored section after the widget type', () => {
    expect(sectionFor('dk_w')).toBe('pkg:dk_w');
  });
});

describe('isDue', () => {
  const c = collectorsFrom([spec(base)])[0];
  it('runs when never run, when the interval has passed, or when forced', () => {
    expect(isDue(c, undefined, 1000)).toBe(true);
    expect(isDue(c, 1000, 5000)).toBe(false);
    expect(isDue(c, 1000, 11_000)).toBe(true);
    expect(isDue(c, 10_500, 11_000, true)).toBe(true);
  });
});

describe('runCollector', () => {
  const c = collectorsFrom([spec({ ...base, map: { name: 'Names' } })])[0];
  const out = (o: Record<string, unknown>) => async () => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false, ...o });

  it('parses and shapes the output', async () => {
    const r = await runCollector(c, 'linux', out({ stdout: '{"Names":"web","State":"running"}\n{"Names":"db"}\n' }));
    expect(r).toEqual({ ok: true, data: [{ Names: 'web', State: 'running', name: 'web' }, { Names: 'db', name: 'db' }] });
  });

  it('reports failures instead of storing bad data', async () => {
    expect(await runCollector(c, 'linux', out({ exitCode: 1, stderr: 'permission denied\n' }))).toEqual({ ok: false, error: 'permission denied' });
    expect(await runCollector(c, 'linux', out({ timedOut: true }))).toEqual({ ok: false, error: 'The command timed out' });
    expect((await runCollector(c, 'linux', out({ stdout: 'not json' }))).ok).toBe(false);
    expect(await runCollector(c, 'linux', async () => { throw new Error('connection lost'); })).toEqual({ ok: false, error: 'connection lost' });
  });

  it('needs a windowsCommand on Windows, wraps it for PowerShell and cleans CLIXML', async () => {
    expect(await runCollector(c, 'windows', out({}))).toEqual({ ok: false, error: 'This widget is not available on Windows hosts' });
    const w = collectorsFrom([spec({ ...base, parse: 'text', windowsCommand: 'Get-Date' })])[0];
    let seen = '';
    const r = await runCollector(w, 'windows', async (cmd: string) => { seen = cmd; return { stdout: 'ok', stderr: '', exitCode: 0, timedOut: false }; });
    expect(seen).toMatch(/^powershell\.exe /);
    expect(r).toEqual({ ok: true, data: { text: 'ok' } });
    const failed = await runCollector(w, 'windows', out({ exitCode: 1, stderr: '#< CLIXML\n<Objs><S S="Error">boom_x000D__x000A_</S></Objs>' }));
    expect(failed).toEqual({ ok: false, error: 'boom' });
  });
});

describe('tracked statistics', () => {
  const tracked = { type: 'dk_w', spec: JSON.stringify({ data: { ...base }, metrics: [
    { name: 'cpu.usage' },
    { name: 'dk.running', from: { agg: 'count', where: { field: 'state', equals: 'running' } } },
    { name: 'dk.mem', from: { agg: 'sum', field: 'mem' } },
  ] }) };

  it('computes only the statistics that come from the data', async () => {
    const c = collectorsFrom([tracked])[0];
    expect(c.metrics.map((m: any) => m.name)).toEqual(['dk.running', 'dk.mem']);
    const out = async () => ({ stdout: '{"state":"running","mem":10}\n{"state":"exited","mem":5}\n{"state":"running","mem":"7"}\n', stderr: '', exitCode: 0, timedOut: false });
    const r = await runCollector(c, 'linux', out);
    expect(metricsOf(c, r)).toEqual({ 'dk.running': 2, 'dk.mem': 22 });
    expect(metricsOf(c, { ok: false, error: 'x' })).toEqual({});
  });

  it('finds snapshot-sourced widgets that track statistics', () => {
    const rows = [{ type: 'snap', spec: JSON.stringify({ data: { source: 'snapshot', section: 'docker', path: 'containers' }, metrics: [{ name: 'dk.n', from: { agg: 'count' } }] }) },
      { type: 'plain', spec: JSON.stringify({ data: { source: 'snapshot', section: 'docker' } }) }];
    const t = snapshotTrackersFrom(rows);
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ type: 'snap', section: 'docker', path: 'containers' });
  });
});
