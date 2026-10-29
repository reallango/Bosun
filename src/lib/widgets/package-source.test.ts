import { describe, it, expect } from 'vitest';
import { listRemotePackages, fetchRemotePackage, isAllowedRef, SourceError } from './package-source';

const manifest = (id: string, extra: Record<string, unknown> = {}) => JSON.stringify({
  schema: 1, id, name: id.toUpperCase(), version: '0.0.1',
  widgets: [{ type: `${id}_w`, display_name: id }], ...extra,
});

/** A fake GitHub: `files` maps repo paths to content. */
function fakeGithub(files: Record<string, string>, opts: { status?: number } = {}) {
  const calls: string[] = [];
  const f = async (url: string) => {
    calls.push(url);
    const respond = (status: number, body = '') => ({ ok: status < 400, status, headers: { get: () => null }, text: async () => body });
    if (opts.status) return respond(opts.status);
    const api = url.match(/api\.github\.com\/repos\/[^/]+\/[^/]+\/contents\/([^?]*)\?ref=/);
    if (api) {
      const dir = decodeURIComponent(api[1]);
      const children = new Map<string, string>();
      for (const p of Object.keys(files)) {
        if (!p.startsWith(dir + '/')) continue;
        const rest = p.slice(dir.length + 1);
        const first = rest.split('/')[0];
        children.set(first, rest.includes('/') ? 'dir' : 'file');
      }
      if (!children.size) return respond(404);
      return respond(200, JSON.stringify(Array.from(children).map(([name, type]) => ({ name, type, path: `${dir}/${name}` }))));
    }
    const raw = url.match(/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[^/]+\/(.*)$/);
    if (raw && files[raw[1]] !== undefined) return respond(200, files[raw[1]]);
    return respond(404);
  };
  return { f, calls };
}

describe('isAllowedRef', () => {
  it('only allows main and dev', () => {
    expect(isAllowedRef('main')).toBe(true);
    expect(isAllowedRef('dev')).toBe(true);
    for (const r of ['feature', '../x', 'main ', '', null, undefined, 3]) expect(isAllowedRef(r)).toBe(false);
  });
});

describe('listRemotePackages', () => {
  it('lists valid packages and reports invalid ones as skipped', async () => {
    const { f } = fakeGithub({
      'widgets/alpha/manifest.json': manifest('alpha'),
      'widgets/beta/manifest.json': manifest('wrong_id'),            // id must match the folder
      'widgets/gamma/manifest.json': '{not json',
      'widgets/server_summary/manifest.json': manifest('server_summary'), // system id
      'widgets/_template/manifest.json': manifest('tmpl'),            // underscore folders are ignored
      'widgets/README.md': 'hi',
    });
    const r = await listRemotePackages('main', f);
    expect(r.packages.map(p => p.id)).toEqual(['alpha']);
    expect(r.skipped.map(s => s.dir).sort()).toEqual(['beta', 'gamma', 'server_summary']);
    expect(r.skipped.find(s => s.dir === 'beta')?.error).toMatch(/must match/);
  });

  it('treats a missing widgets/ folder as empty, but other failures as errors', async () => {
    expect((await listRemotePackages('dev', fakeGithub({}).f)).packages).toEqual([]);
    await expect(listRemotePackages('main', fakeGithub({}, { status: 500 }).f)).rejects.toBeInstanceOf(SourceError);
  });

  it('only talks to the fixed repository', async () => {
    const { f, calls } = fakeGithub({ 'widgets/alpha/manifest.json': manifest('alpha') });
    await listRemotePackages('dev', f);
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c).toMatch(/^https:\/\/(api\.github\.com\/repos|raw\.githubusercontent\.com)\/reallango\/Bosun\//);
    expect(calls.some(c => c.includes('ref=dev') || c.includes('/dev/'))).toBe(true);
  });
});

describe('fetchRemotePackage', () => {
  it('downloads the manifest and its text files', async () => {
    const { f } = fakeGithub({
      'widgets/alpha/manifest.json': manifest('alpha'),
      'widgets/alpha/actions/run.json': '{"run":true}',
      'widgets/alpha/README.md': 'docs',
    });
    const p = await fetchRemotePackage('main', 'alpha', f);
    expect(p.manifest.id).toBe('alpha');
    expect(p.files).toEqual({ 'actions/run.json': '{"run":true}', 'README.md': 'docs' });
  });

  it('refuses bad ids, invalid packages and unreadable files', async () => {
    const { f } = fakeGithub({ 'widgets/alpha/manifest.json': manifest('other'), 'widgets/beta/manifest.json': manifest('beta'), 'widgets/beta/bad name.txt': 'x' });
    await expect(fetchRemotePackage('main', '../etc', f)).rejects.toThrow(/Invalid package id/);
    await expect(fetchRemotePackage('main', 'alpha', f)).rejects.toThrow(/must match/);
    await expect(fetchRemotePackage('main', 'beta', f)).rejects.toThrow(/not allowed|not valid/);
    await expect(fetchRemotePackage('main', 'missing', f)).rejects.toThrow();
  });
});
