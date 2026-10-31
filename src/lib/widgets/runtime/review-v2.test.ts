import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { validateManifest, scriptFilesOf } from '@/lib/widgets/package-manifest';
import { reviewPackage } from './review';

const dir = path.join(process.cwd(), 'widgets');
const load = (name: string) => {
  const m = validateManifest(JSON.parse(fs.readFileSync(path.join(dir, name, 'manifest.json'), 'utf8')));
  if (!m.ok) throw new Error(m.error);
  return m.value;
};

describe('the install review of a package with scripts', () => {
  it('counts scripts, so a package made only of scripts still asks for confirmation', () => {
    for (const name of ['ollama', 'updates', 'commands']) {
      const r = reviewPackage(load(name));
      expect(r.commandCount, name).toBeGreaterThan(0);
      expect(r.widgets.flatMap(w => w.scripts).length, name).toBeGreaterThan(0);
    }
  });

  it('lists every script with its account, what uses it and the hosts the package may contact', () => {
    const r = reviewPackage(load('ollama'));
    const scripts = r.widgets.flatMap(w => w.scripts);
    expect(scripts.length).toBe(Object.keys(load('ollama').widgets[0].spec!.scripts!).length);
    expect(scripts.every(s => s.as === 'service' || s.as === 'shell')).toBe(true);
    expect(r.network.length).toBeGreaterThan(0);
    expect(r.runsAsService).toBe(true);
    expect(scripts.some(s => s.usedBy.some(u => /state check/.test(u)))).toBe(true);
    expect(scripts.some(s => s.usedBy.some(u => /action/.test(u)))).toBe(true);
  });

  it('shows the hash and the text of each script file when the files are at hand', () => {
    const m = load('commands');
    const files = Object.fromEntries(scriptFilesOf(m).map(f => [f, `# ${f}\necho hi\n`]));
    const r = reviewPackage(m, files);
    const f = r.widgets[0].scripts[0].files[0];
    expect(f.sha256).toBe(crypto.createHash('sha256').update(files[f.file], 'utf8').digest('hex'));
    expect(f.text).toBe(files[f.file]);
    const without = reviewPackage(m).widgets[0].scripts[0].files[0];
    expect(without.sha256).toBeUndefined();
    expect(without.text).toBeUndefined();
  });

  it('shortens a very long script text but hashes all of it', () => {
    const m = load('commands');
    const long = 'x'.repeat(50_000);
    const files = Object.fromEntries(scriptFilesOf(m).map(f => [f, long]));
    const f = reviewPackage(m, files).widgets[0].scripts[0].files[0];
    expect(f.text!.length).toBe(20_000);
    expect(f.truncated).toBe(true);
    expect(f.sha256).toBe(crypto.createHash('sha256').update(long, 'utf8').digest('hex'));
  });

  it('a version 1 package is reviewed as before', () => {
    const r = reviewPackage(load('commands'));
    expect(r.permissions.length).toBeGreaterThan(0);
  });
});
