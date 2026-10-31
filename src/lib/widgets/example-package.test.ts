import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { validateManifest, validateFiles, validateScriptFiles } from './package-manifest';
import { reviewPackage } from './runtime/review';
import { reservedPackageNames } from './system-packages';
import { buildScriptInvocation } from './runtime/script-run';

// The worked example of docs/create-your-own-widget.md. It is not shipped (not in widgets/bundled.json); it stays here as a
// fixture so the guide cannot drift from what Bosun accepts, and as proof that a package needs nothing from Bosun's own code.
const dir = path.join(process.cwd(), 'docs', 'examples', 'hello_host');
const hasSh = process.platform !== 'win32' && spawnSync('sh', ['-c', 'exit 0']).status === 0;

const load = () => {
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const { types, ids } = reservedPackageNames();
  const r = validateManifest(raw, { reservedTypes: types, reservedIds: ids });
  if (!r.ok) throw new Error(r.error);
  const files: Record<string, string> = {};
  for (const f of ['scripts/hello.sh', 'scripts/hello.ps1']) files[f] = fs.readFileSync(path.join(dir, f), 'utf8');
  return { manifest: r.value, files };
};

describe('the Hello Host example package', () => {
  it('is a valid package with every script it names', () => {
    const { manifest, files } = load();
    expect(manifest.id).toBe('hello_host');
    expect(validateFiles(files).ok).toBe(true);
    const ok = validateScriptFiles(manifest, files);
    if (!ok.ok) throw new Error(ok.error);
    expect(reviewPackage(manifest, files).commandCount).toBeGreaterThan(0);
  });

  it('is not installed by default', () => {
    const bundled: string[] = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'widgets', 'bundled.json'), 'utf8'));
    expect(JSON.stringify(bundled)).not.toContain('hello_host');
  });

  it.skipIf(!hasSh)('its Linux script prints the JSON the view reads', () => {
    const { files } = load();
    const inv = buildScriptInvocation('linux', files['scripts/hello.sh'], { greeting: 'Hi there' });
    const r = spawnSync('sh', ['-c', inv.command], { input: inv.stdin, encoding: 'utf8' });
    const out = JSON.parse(r.stdout.trim().split('\n').pop() as string);
    expect(out.message).toMatch(/^Hi there, /);
    expect(typeof out.uptime).toBe('string');
  });
});
