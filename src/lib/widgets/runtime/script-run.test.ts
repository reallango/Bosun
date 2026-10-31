import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { buildScriptInvocation, parseScriptOutput, parseStateOutput, quotePs, quoteSh, scriptFileFor } from './script-run';

const hasSh = spawnSync('sh', ['-c', 'exit 0']).status === 0;

describe('building a script invocation', () => {
  it('Linux: the script travels on stdin and parameters as quoted environment variables, never in the script text', () => {
    const inv = buildScriptInvocation('linux', 'echo "$BOSUN_PARAM_name"\n', { name: `it's; rm -rf /` });
    expect(inv.stdin).toBe('echo "$BOSUN_PARAM_name"\n');
    expect(inv.command).toContain(`BOSUN_PARAM_name='it'\\''s; rm -rf /'`);
    expect(inv.command).toContain('BOSUN_PARAMS=');
    expect(inv.command).not.toContain('echo "$BOSUN_PARAM_name"');
  });

  it('Windows: a preamble of quoted values, then the script; typographic quotes cannot end the string', () => {
    const inv = buildScriptInvocation('windows', 'Write-Output $env:BOSUN_PARAM_name', { name: 'a’; calc' });
    expect(inv.stdin).toBeUndefined();
    const lines = inv.command.split('\n');
    expect(lines[0]).toMatch(/^\$env:BOSUN_PARAMS = '/);
    expect(lines[1]).toBe("$env:BOSUN_PARAM_name = 'a’’; calc'");
    expect(lines[2]).toBe('Write-Output $env:BOSUN_PARAM_name');
  });

  it('refuses an unsafe parameter name', () => {
    expect(() => buildScriptInvocation('linux', 'x', { 'a b': '1' })).toThrow(/invalid parameter name/);
    expect(() => buildScriptInvocation('windows', 'x', { 'A;calc': '1' })).toThrow();
  });

  it('quotes for each shell', () => {
    expect(quoteSh(`a'b`)).toBe(`'a'\\''b'`);
    expect(quotePs(`a'b`)).toBe(`'a''b'`);
  });

  it.skipIf(!hasSh)('actually runs: the values arrive intact and the script cannot read its own source from stdin', () => {
    const script = 'cat >/dev/null 2>&1; echo "name=$BOSUN_PARAM_name"; echo "n=$BOSUN_PARAM_count"; echo "json=$BOSUN_PARAMS"\n';
    const nasty = `x'; echo INJECTED; '$(id) \`id\` "q"`;
    const inv = buildScriptInvocation('linux', script, { name: nasty, count: '7' });
    const r = spawnSync('sh', ['-c', inv.command], { input: inv.stdin, encoding: 'utf8' });
    expect(r.status).toBe(0);
    const lines = r.stdout.split('\n');
    expect(lines[0]).toBe(`name=${nasty}`);
    expect(lines[1]).toBe('n=7');
    expect(JSON.parse(lines[2].slice(5))).toEqual({ name: nasty, count: '7' });
    expect(r.stdout).not.toContain('INJECTED\n');
  });

  it.skipIf(!hasSh)('passes the exit code through and removes its temporary file', () => {
    const inv = buildScriptInvocation('linux', 'echo oops >&2\nexit 3\n');
    const r = spawnSync('sh', ['-c', inv.command], { input: inv.stdin, encoding: 'utf8' });
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('oops');
  });
});

describe('the output protocol', () => {
  it('reads steps, progress, done and error', () => {
    const o = parseScriptOutput('[step] Downloading\nsome output\nPROGRESS 3/10\n[step] Installing\nPROGRESS 50%\nDONE all good\n');
    expect(o.steps).toEqual(['Downloading', 'Installing']);
    expect(o.progress).toEqual({ done: 50, total: 100, percent: 50 });
    expect(o.done).toBe('all good');
    expect(o.error).toBeNull();
    expect(o.lines).toEqual(['some output']);
  });

  it('the last of DONE and ERROR wins, and CRLF output works', () => {
    expect(parseScriptOutput('DONE ok\r\nERROR: then it broke\r\n').error).toBe('then it broke');
    expect(parseScriptOutput('DONE ok\r\nERROR: then it broke\r\n').done).toBeNull();
    expect(parseScriptOutput('ERROR: first\nDONE fixed\n').done).toBe('fixed');
  });

  it('computes a percentage and ignores nonsense', () => {
    expect(parseScriptOutput('PROGRESS 1/4\n').progress).toEqual({ done: 1, total: 4, percent: 25 });
    expect(parseScriptOutput('PROGRESS 9/0\n').progress).toBeNull();
    expect(parseScriptOutput('PROGRESS 99/4\n').progress?.percent).toBe(100);
    expect(parseScriptOutput('DONEISH\n').done).toBeNull();
  });
});

describe('state output', () => {
  const fields = { 'ollama.installed': 'boolean', 'ollama.version': 'string', 'ollama.port': 'number', 'ollama.env.context': 'number' };

  it('builds the nested, typed object from declared keys only', () => {
    const o = parseStateOutput('ollama.installed=true\nollama.version=0.5.1\nollama.port=11434\nollama.env.context=4096\nother=1\n', fields);
    expect(o).toEqual({ ollama: { installed: true, version: '0.5.1', port: 11434, env: { context: 4096 } } });
  });

  it('leaves out a value of the wrong type, takes the last line for a key, ignores comments and CRLF', () => {
    const o = parseStateOutput('# header\r\nollama.port=abc\r\nollama.installed=yes\r\nollama.installed=0\r\nollama.version=  1.2  \r\nnoequals\r\n', fields);
    expect(o).toEqual({ ollama: { installed: false, version: '1.2' } });
  });

  it('cannot pollute prototypes through a key', () => {
    const o = parseStateOutput('a.__proto__.x=1\nconstructor.y=2\nok=1\n', { 'a.__proto__.x': 'number', 'constructor.y': 'number', ok: 'number' });
    expect(o).toEqual({ ok: 1 });
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it('limits what it takes', () => {
    const many = Array.from({ length: 800 }, (_, i) => `k${i}=1`).join('\n');
    const f = Object.fromEntries(Array.from({ length: 800 }, (_, i) => [`k${i}`, 'number']));
    expect(Object.keys(parseStateOutput(many, f)).length).toBe(500);
    expect((parseStateOutput(`s=${'x'.repeat(9000)}`, { s: 'string' }).s as string).length).toBe(4000);
  });
});

describe('scriptFileFor', () => {
  it('picks the file of the platform or null', () => {
    expect(scriptFileFor({ linux: 'a.sh' }, 'linux')).toBe('a.sh');
    expect(scriptFileFor({ linux: 'a.sh' }, 'windows')).toBeNull();
    expect(scriptFileFor({ windows: 'a.ps1' }, 'windows')).toBe('a.ps1');
  });
});
