import { describe, it, expect } from 'vitest';
import { validateManifest, validateFiles, compareVersions, manifestToJson } from './package-manifest';
import { readZip, writeZip, crc32, isSafeEntryName, ZipError } from './zip';
import { systemPackages, reservedPackageNames } from './system-packages';

const good = () => ({
  schema: 1, id: 'hello_pkg', name: 'Hello', version: '0.0.1', description: 'd', author: 'me',
  permissions: [{ id: 'hello_pkg.run', label: 'Run hello', description: 'Runs it', group: 'Hello', defaultLevel: 'admin', risk: 'low', scope: 'server' }],
  widgets: [{ type: 'hello_widget', display_name: 'Hello', description: 'x', default_size: { w: 4, h: 3 }, spec: { version: 1, data: { source: 'snapshot', section: 'docker', permission: 'hello_pkg.run' }, view: { type: 'text', text: '{x}' } } }],
});

describe('validateManifest', () => {
  it('accepts a good manifest and normalises the widget columns', () => {
    const r = validateManifest(good());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.widgets[0].columns.display_name).toBe('Hello');
      expect(r.value.widgets[0].columns.default_size).toBe('{"w":4,"h":3}');
      expect(r.value.widgets[0].spec?.data).toEqual({ source: 'snapshot', section: 'docker', permission: 'hello_pkg.run' });
      expect(r.value.permissions[0].implies).toEqual([]);
    }
  });

  it('rejects bad ids, versions, schema and shapes', () => {
    const bad = (mut: (m: any) => void) => { const m: any = good(); mut(m); return validateManifest(m); };
    expect(bad(m => { m.schema = 2; }).ok).toBe(false);
    expect(bad(m => { m.id = 'Bad-Id'; }).ok).toBe(false);
    expect(bad(m => { m.version = '1.0'; }).ok).toBe(false);
    expect(bad(m => { m.version = '1.0.0-beta'; }).ok).toBe(false);
    expect(bad(m => { m.name = ''; }).ok).toBe(false);
    expect(bad(m => { m.widgets = []; }).ok).toBe(false);
    expect(bad(m => { m.widgets[0].type = 'Not Valid'; }).ok).toBe(false);
    expect(bad(m => { m.widgets.push(m.widgets[0]); }).ok).toBe(false);
    expect(bad(m => { m.widgets[0].spec = [1]; }).ok).toBe(false);
    expect(bad(m => { m.widgets[0].default_size = { w: 0, h: 1 }; }).ok).toBe(false);
    expect(validateManifest(null).ok).toBe(false);
    expect(validateManifest([]).ok).toBe(false);
  });

  it('refuses to take over system packages, widget types and built-in permissions', () => {
    const { types, ids } = reservedPackageNames();
    expect(ids).toContain('ssh_terminal');
    expect(validateManifest({ ...good(), id: 'ssh_terminal' }, { reservedIds: ids, reservedTypes: types }).ok).toBe(false);
    const m: any = good(); m.widgets[0].type = 'ssh_terminal';
    expect(validateManifest(m, { reservedIds: ids, reservedTypes: types }).ok).toBe(false);
    const p: any = good(); p.permissions[0].id = 'updates.check';
    expect(validateManifest(p).ok).toBe(false);
    const q: any = good(); q.permissions[0].id = 'other_pkg.run';
    expect(validateManifest(q).ok).toBe(false);
    const dup: any = good(); dup.permissions.push(dup.permissions[0]);
    expect(validateManifest(dup).ok).toBe(false);
  });

  it('does not let a package imply a stronger built-in permission', () => {
    const m: any = good(); m.permissions[0].implies = ['commands.run'];
    expect(validateManifest(m).ok).toBe(false);
    m.permissions[0].implies = ['power.restart'];
    expect(validateManifest(m).ok).toBe(false);
    m.permissions[0].implies = ['servers.refresh'];
    expect(validateManifest(m).ok).toBe(true);
    m.permissions[0].implies = ['nope.nothing'];
    expect(validateManifest(m).ok).toBe(false);
  });

  it('round-trips through manifestToJson', () => {
    const r = validateManifest(good());
    if (!r.ok) throw new Error(r.error);
    const again = validateManifest(manifestToJson(r.value));
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.value.widgets[0].columns).toEqual(r.value.widgets[0].columns);
  });
});

describe('compareVersions', () => {
  it('orders numerically, not as text', () => {
    expect(compareVersions('0.0.1', '0.0.2')).toBeLessThan(0);
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0);
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('2.0.0', '1.99.99')).toBeGreaterThan(0);
  });
});

describe('validateFiles', () => {
  it('accepts small text files and rejects the rest', () => {
    expect(validateFiles({ 'actions/a.json': '{}', 'README.md': Buffer.from('hi') }).ok).toBe(true);
    for (const name of ['../x', '/abs', 'a//b', '.hidden', 'a/../b', 'a b', 'back\\slash']) {
      expect(validateFiles({ [name]: 'x' }).ok, name).toBe(false);
    }
    expect(validateFiles({ 'bin.dat': Buffer.from([1, 0, 2]) }).ok).toBe(false);
    expect(validateFiles({ 'big.txt': 'a'.repeat(300 * 1024) }).ok).toBe(false);
    expect(validateFiles({ 'bad.txt': Buffer.from([0xff, 0xfe, 0xfd]) }).ok).toBe(false);
  });
});

describe('zip', () => {
  it('round-trips files, including compressible and empty ones', () => {
    const entries = { 'manifest.json': JSON.stringify(good()), 'a/b.txt': 'x'.repeat(5000), 'empty.txt': '' };
    const out = readZip(writeZip(entries));
    expect(Object.keys(out).sort()).toEqual(Object.keys(entries).sort());
    expect(out['a/b.txt'].toString()).toBe('x'.repeat(5000));
    expect(out['empty.txt'].length).toBe(0);
  });
  it('knows the CRC-32 check value', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });
  it('rejects unsafe names, bombs, damaged and non-zip input', () => {
    expect(isSafeEntryName('manifest.json')).toBe(true);
    for (const n of ['../evil', 'a/../../b', '/etc/passwd', 'C:\\x', 'a\\b', '']) expect(isSafeEntryName(n), n).toBe(false);
    expect(() => readZip(writeZip({ '../evil': 'x' }))).toThrow(ZipError);
    expect(() => readZip(writeZip({ big: 'a'.repeat(100000) }), { maxEntries: 5, maxEntryBytes: 1000, maxTotalBytes: 5000 })).toThrow(/larger/);
    expect(() => readZip(writeZip({ a: 'a'.repeat(900), b: 'b'.repeat(900) }), { maxEntries: 5, maxEntryBytes: 1000, maxTotalBytes: 1500 })).toThrow(/too much/);
    expect(() => readZip(writeZip(Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`f${i}`, 'x']))), { maxEntries: 5, maxEntryBytes: 1000, maxTotalBytes: 5000 })).toThrow(/more than/);
    expect(() => readZip(Buffer.from('not a zip'))).toThrow(ZipError);
    const z = writeZip({ f: 'hello world hello world' });
    z[40] ^= 0xff; // corrupt the data
    expect(() => readZip(z)).toThrow(ZipError);
  });
});

describe('system packages', () => {
  it('lists every compiled widget plus Ollama Status at 0.0.1', () => {
    const all = systemPackages();
    const ids = all.map(p => p.id);
    for (const id of ['ssh_terminal', 'ollama_status', 'os_update_check', 'custom_command']) expect(ids).toContain(id);
    expect(all.every(p => p.version === '0.0.1')).toBe(true);
    expect(all.find(p => p.id === 'ollama_status')?.permissions).toContain('ollama.models.pull');
  });
});

import fs from 'fs';
import path from 'path';
import { reservedPackageNames } from './system-packages';
import { reviewPackage } from './runtime/review';

describe('packages shipped in the repository', () => {
  const root = path.join(process.cwd(), 'widgets');
  const dirs = fs.existsSync(root) ? fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.startsWith('_')) : [];

  it('has at least the Docker package', () => {
    expect(dirs.map(d => d.name)).toContain('docker');
  });

  for (const d of dirs) {
    it(`${d.name} is a valid package whose id matches its folder`, () => {
      const raw = JSON.parse(fs.readFileSync(path.join(root, d.name, 'manifest.json'), 'utf8'));
      const { types, ids } = reservedPackageNames();
      const r = validateManifest(raw, { reservedTypes: types, reservedIds: ids });
      if (!r.ok) throw new Error(r.error);
      expect(r.value.id).toBe(d.name);
      // Every widget declares what it needs to be seen, and every command is reviewable.
      for (const w of r.value.widgets) expect(w.spec?.data.permission).toBeTruthy();
      const review = reviewPackage(r.value);
      expect(review.widgets).toHaveLength(r.value.widgets.length);
      // A package that runs commands is reviewable: every command shows up in the review.
      const runs = r.value.widgets.some(w => w.spec?.data.source === 'command' || (w.spec?.actions.length ?? 0) > 0);
      if (runs) expect(review.commandCount).toBeGreaterThan(0);
    });
  }

  it('the Docker package offers what the built-in Docker widget does', () => {
    const raw = JSON.parse(fs.readFileSync(path.join(root, 'docker', 'manifest.json'), 'utf8'));
    const r = validateManifest(raw);
    if (!r.ok) throw new Error(r.error);
    const spec = r.value.widgets[0].spec!;
    expect(spec.actions.map(a => a.id).sort()).toEqual(['logs', 'restart', 'shell', 'start', 'stop']);
    // The shell button opens the web terminal in the container; it runs no command.
    const shell = spec.actions.find(a => a.id === 'shell')!;
    expect(shell).toMatchObject({ kind: 'terminal', terminal: { container: 'name' }, permission: 'docker.shell', command: '' });
    expect(spec.view.row?.actions).toEqual(['logs', 'shell', 'restart', 'stop', 'start']);
    expect(spec.view.filter?.fields).toEqual(['name', 'image']);
    expect(spec.view.toggles?.[0].key).toBe('stopped');
  });
});
