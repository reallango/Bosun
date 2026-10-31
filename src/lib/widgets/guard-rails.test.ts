import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Guard rail for the rule behind widget packages: nothing in Bosun's own code is made for one widget. A widget is a package
 * (its scripts, settings, permissions and screen live in it), so a person can write their own without touching Bosun. This
 * test fails when a source file of Bosun itself names a widget type, a package id or a permission of a bundled package.
 *
 * What may stay is listed, with the reason, in guard-rails.allow.json next to this file. Adding to that list needs a
 * reason a reviewer can accept: "it is easier" is not one.
 */

const root = process.cwd();

interface Allowed { file: string; names: string[]; reason: string }
const allow: Allowed[] = JSON.parse(fs.readFileSync(path.join(root, 'src', 'lib', 'widgets', 'guard-rails.allow.json'), 'utf8')).allowed;

function bundled() {
  const types = new Set<string>(); const perms = new Set<string>(); const ids = new Set<string>();
  const dir = path.join(root, 'widgets');
  for (const id of fs.readdirSync(dir)) {
    const f = path.join(dir, id, 'manifest.json');
    if (!fs.existsSync(f)) continue;
    const m = JSON.parse(fs.readFileSync(f, 'utf8'));
    ids.add(m.id);
    for (const p of m.permissions ?? []) perms.add(p.id);
    for (const w of m.widgets ?? []) types.add(w.type);
  }
  return { types, perms, ids };
}

/** Source files of Bosun itself (not tests, not the migrations that record history, not the packages). */
function coreSources(): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '.next') walk(p); continue; }
      if (!/\.(ts|tsx|js|mjs)$/.test(e.name) || /\.test\.|\.allow\./.test(e.name)) continue;
      out.push(p);
    }
  };
  walk(path.join(root, 'src'));
  for (const f of ['poller.js', 'ws-server.js']) out.push(path.join(root, f));
  return out.filter(f => !path.relative(root, f).replace(/\\/g, '/').startsWith('src/lib/db/migrations/'));
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

describe('nothing in Bosun itself is made for one widget', () => {
  const { types, perms, ids } = bundled();

  it('knows the bundled packages (so the check below cannot pass by finding nothing)', () => {
    expect(ids.size).toBeGreaterThanOrEqual(10);
    expect(types.has('ollama_status')).toBe(true);
    expect(perms.has('docker.shell')).toBe(true);
  });

  it('no source of Bosun names a widget type, a package id or a permission of a bundled package', () => {
    const offenders: string[] = [];
    for (const file of coreSources()) {
      const rel = path.relative(root, file).replace(/\\/g, '/');
      const allowed = new Set(allow.filter(a => a.file === rel).flatMap(a => a.names));
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      const find = (name: string, re: RegExp, kind: string) => {
        if (allowed.has(name)) return;
        lines.forEach((l, i) => { if (re.test(l)) offenders.push(`${rel}:${i + 1}  ${kind} "${name}"  ${l.trim().slice(0, 100)}`); });
      };
      for (const t of Array.from(types)) find(t, new RegExp(`['"\`]${esc(t)}['"\`]`), 'widget type');
      for (const i of Array.from(ids)) find(i, new RegExp(`['"\`]${esc(i)}['"\`]`), 'package id');
      for (const p of Array.from(perms)) find(p, new RegExp(`(^|[^A-Za-z0-9_.-])${esc(p)}($|[^A-Za-z0-9_-])`), 'permission');
    }
    expect(offenders, `\n${offenders.join('\n')}\n`).toEqual([]);
  });

  it('every entry of the allow list is still needed and has a reason', () => {
    const stale: string[] = [];
    for (const a of allow) {
      expect(a.reason.length, `${a.file}: a reason is required`).toBeGreaterThan(15);
      const f = path.join(root, a.file);
      if (!fs.existsSync(f)) { stale.push(`${a.file} does not exist`); continue; }
      const text = fs.readFileSync(f, 'utf8');
      for (const n of a.names) if (!text.includes(n)) stale.push(`${a.file} no longer mentions ${n}`);
    }
    expect(stale).toEqual([]);
  });
});
