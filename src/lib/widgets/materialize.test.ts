import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  contentHashOf, currentCopy, hash16, materializePackage, materializedIds, plan, readMaterializedFile, removeMaterialized,
} from './materialize';

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'bosun-mat-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const manifest = (v = '1.0.0') => JSON.stringify({ schema: 1, id: 'demo', version: v });
const copy = (over: Partial<Parameters<typeof materializePackage>[1]> = {}) => ({
  id: 'demo', version: '1.0.0', manifest: manifest(), files: { 'scripts/a.sh': 'echo a\n', 'scripts/b.ps1': 'Write-Output b\n', 'README.md': '# demo\n' }, ...over,
});

describe('contentHashOf', () => {
  it('depends on the manifest and on every file name and byte, not on their order', () => {
    const a = contentHashOf(manifest(), { x: '1', y: '2' });
    expect(contentHashOf(manifest(), { y: '2', x: '1' })).toBe(a);
    expect(contentHashOf(manifest('1.0.1'), { x: '1', y: '2' })).not.toBe(a);
    expect(contentHashOf(manifest(), { x: '1', y: '3' })).not.toBe(a);
    expect(contentHashOf(manifest(), { x: '1', z: '2' })).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('materializePackage', () => {
  it('writes the manifest and every file, and makes that copy the current one', () => {
    const r = materializePackage(root, copy());
    expect(r.written).toBe(true);
    expect(currentCopy(root, 'demo')).toBe(hash16(r.hash));
    expect(readMaterializedFile(root, 'demo', 'scripts/a.sh')).toBe('echo a\n');
    expect(readMaterializedFile(root, 'demo', 'scripts/b.ps1')).toBe('Write-Output b\n');
    expect(readMaterializedFile(root, 'demo', 'manifest.json')).toBe(manifest());
    expect(readMaterializedFile(root, 'demo', 'nope.sh')).toBeNull();
    expect(fs.readdirSync(path.join(root, 'demo'))).not.toContain(expect.stringMatching(/^\.tmp-/));
  });

  it('does nothing when the same content is already in place', () => {
    const first = materializePackage(root, copy());
    const again = materializePackage(root, copy());
    expect(again.written).toBe(false);
    expect(again.hash).toBe(first.hash);
  });

  it('switches to a changed package and keeps one previous copy, removing older ones', () => {
    const h1 = materializePackage(root, copy()).hash;
    const h2 = materializePackage(root, copy({ version: '1.0.1', manifest: manifest('1.0.1'), files: { 'scripts/a.sh': 'echo changed\n' } })).hash;
    expect(currentCopy(root, 'demo')).toBe(hash16(h2));
    expect(readMaterializedFile(root, 'demo', 'scripts/a.sh')).toBe('echo changed\n');
    expect(readMaterializedFile(root, 'demo', 'scripts/b.ps1')).toBeNull();            // the old file is not in the new copy
    expect(fs.existsSync(path.join(root, 'demo', hash16(h1)))).toBe(true);              // one previous copy stays
    const h3 = materializePackage(root, copy({ version: '1.0.2', manifest: manifest('1.0.2'), files: { 'scripts/a.sh': 'third\n' } })).hash;
    expect(fs.existsSync(path.join(root, 'demo', hash16(h1)))).toBe(false);
    expect(fs.existsSync(path.join(root, 'demo', hash16(h2)))).toBe(true);
    expect(currentCopy(root, 'demo')).toBe(hash16(h3));
  });

  it('refuses a stored hash that does not match the content, and leaves the current copy alone', () => {
    materializePackage(root, copy());
    const before = currentCopy(root, 'demo');
    expect(() => materializePackage(root, copy({ files: { 'scripts/a.sh': 'tampered\n' }, contentHash: contentHashOf(manifest(), { 'scripts/a.sh': 'echo a\n' }) }))).toThrow(/does not match/);
    expect(currentCopy(root, 'demo')).toBe(before);
    expect(readMaterializedFile(root, 'demo', 'scripts/a.sh')).toBe('echo a\n');
  });

  it('accepts a stored hash that matches', () => {
    const files = { 'scripts/a.sh': 'echo a\n' };
    expect(materializePackage(root, copy({ files, contentHash: contentHashOf(manifest(), files) })).written).toBe(true);
  });

  it('refuses unsafe file names and package ids and writes nothing for them', () => {
    for (const name of ['../x.sh', '/abs.sh', 'a/../b.sh', '.hidden', 'a b.sh', 'back\\slash.sh', 'manifest.json', 'a//b']) {
      expect(() => materializePackage(root, copy({ files: { [name]: 'x' } })), name).toThrow(/unsafe/);
    }
    expect(() => materializePackage(root, copy({ id: '../evil' }))).toThrow(/invalid package id/);
    expect(() => materializePackage(root, copy({ id: 'Upper' }))).toThrow();
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('removes a half-written temporary folder when writing fails', () => {
    // A file name that collides with a directory name makes the second write fail.
    expect(() => materializePackage(root, copy({ files: { 'a/b': 'x', 'a': 'y' } }))).toThrow();
    const leftovers = fs.existsSync(path.join(root, 'demo')) ? fs.readdirSync(path.join(root, 'demo')).filter(n => n.startsWith('.tmp-')) : [];
    expect(leftovers).toEqual([]);
  });

  it('replaces an incomplete copy that was left under the same name', () => {
    const h = contentHashOf(manifest(), { 'scripts/a.sh': 'echo a\n' });
    const dir = path.join(root, 'demo', hash16(h));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'junk'), 'partial');
    const r = materializePackage(root, copy({ files: { 'scripts/a.sh': 'echo a\n' } }));
    expect(r.written).toBe(true);
    expect(fs.existsSync(path.join(dir, 'junk'))).toBe(false);
    expect(readMaterializedFile(root, 'demo', 'scripts/a.sh')).toBe('echo a\n');
  });
});

describe('reading', () => {
  it('only reads the copy that matches the expected hash, so a stale copy is never mistaken for the current one', () => {
    const r = materializePackage(root, copy());
    expect(readMaterializedFile(root, 'demo', 'scripts/a.sh', r.hash)).toBe('echo a\n');
    expect(readMaterializedFile(root, 'demo', 'scripts/a.sh', contentHashOf(manifest('9.9.9'), {}))).toBeNull();
  });

  it('never reads outside the package folder', () => {
    materializePackage(root, copy());
    for (const name of ['../../etc/passwd', '../demo/CURRENT', '/etc/passwd', 'a/../../x']) {
      expect(readMaterializedFile(root, 'demo', name), name).toBeNull();
    }
    expect(readMaterializedFile(root, '../demo', 'manifest.json')).toBeNull();
  });
});

describe('plan and removal', () => {
  it('says what to write, keep and remove', () => {
    const a = materializePackage(root, copy({ id: 'aa' })).hash;
    const b = materializePackage(root, copy({ id: 'bb' })).hash;
    materializePackage(root, copy({ id: 'gone' }));
    const changedB = contentHashOf(manifest('2.0.0'), {});
    const p = plan(root, [{ id: 'aa', contentHash: a }, { id: 'bb', contentHash: changedB }, { id: 'new', contentHash: b }]);
    expect(p.keep).toEqual(['aa']);
    expect(p.write.sort()).toEqual(['bb', 'new']);
    expect(p.remove).toEqual(['gone']);
  });

  it('removes everything a node holds for a package', () => {
    materializePackage(root, copy());
    expect(materializedIds(root)).toEqual(['demo']);
    expect(removeMaterialized(root, 'demo')).toBe(true);
    expect(removeMaterialized(root, 'demo')).toBe(false);
    expect(materializedIds(root)).toEqual([]);
    expect(removeMaterialized(root, '../x')).toBe(false);
  });
});
