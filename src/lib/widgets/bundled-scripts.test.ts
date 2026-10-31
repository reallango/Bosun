import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';
import { spawnSync } from 'child_process';
import { readBundledPackages } from './bundled';
import { validateScriptFiles } from './package-manifest';
import { buildScriptInvocation } from './runtime/script-run';

const root = path.join(process.cwd(), 'widgets');
const hasSh = spawnSync('sh', ['-c', 'exit 0']).status === 0;

describe('the scripts of the bundled packages', () => {
  const { packages } = readBundledPackages(root);

  it('every script a bundled package names is in the package, and none is empty', () => {
    for (const p of packages) expect(validateScriptFiles(p.manifest, p.files).ok, p.manifest.id).toBe(true);
  });

  it('shell scripts use LF line endings (a CRLF script does not run on Linux)', () => {
    for (const p of packages) for (const [name, text] of Object.entries(p.files)) if (name.endsWith('.sh')) expect(text.includes('\r'), `${p.manifest.id}/${name}`).toBe(false);
  });

  it('a script is only declared for a platform it has a file for, and the file ends the way the platform expects', () => {
    for (const p of packages) for (const w of p.manifest.widgets) for (const [id, s] of Object.entries(w.spec?.scripts ?? {})) {
      if (s.linux) expect(s.linux.endsWith('.sh'), `${p.manifest.id}/${id}`).toBe(true);
      if (s.windows) expect(s.windows.endsWith('.ps1'), `${p.manifest.id}/${id}`).toBe(true);
    }
  });
});

describe('Custom Command (Linux script)', () => {
  const script = fs.readFileSync(path.join(root, 'commands', 'scripts', 'run.sh'), 'utf8');
  const run = (command: string) => {
    const inv = buildScriptInvocation('linux', script, { command });
    return spawnSync('sh', ['-c', inv.command], { input: inv.stdin, encoding: 'utf8' });
  };

  it.skipIf(!hasSh)('prints the output of the command and succeeds', () => {
    const r = run('echo hello; echo problem >&2');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('hello');
    expect(r.stdout).toContain('problem');
  });

  it.skipIf(!hasSh)('reports a failing command in the output, and still succeeds so the output is shown', () => {
    const r = run('echo before; exit 3');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('before');
    expect(r.stdout).toContain('exited with code 3');
  });

  it.skipIf(!hasSh)('runs the command as given: quotes and shell syntax belong to the command, not to the script', () => {
    const r = run(`echo "a'b" && echo $((1+2))`);
    expect(r.stdout).toContain("a'b");
    expect(r.stdout).toContain('3');
  });
});
