import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// An in-memory widget_packages table that answers the handful of queries the sync service makes.
interface Pkg { id: string; version: string; manifest: string; files: string; content_hash: string | null }
const db = vi.hoisted(() => ({ rows: [] as Pkg[] }));

vi.mock('@/lib/db/rqlite-client', () => {
  const result = (columns: string[], values: unknown[][]) => ({ columns, values });
  return {
    rowsToObjects: (r: { columns: string[]; values: unknown[][] }) => (r.values ?? []).map(v => Object.fromEntries(r.columns.map((c, i) => [c, v[i]]))),
    rqlite: {
      async query(sql: string, params: unknown[] = []) {
        if (/WHERE content_hash IS NULL/.test(sql)) return result(['id'], db.rows.filter(r => r.content_hash === null).map(r => [r.id]));
        if (/SELECT id, version, manifest, files, content_hash FROM widget_packages WHERE id = \?/.test(sql)) {
          return result(['id', 'version', 'manifest', 'files', 'content_hash'], db.rows.filter(r => r.id === params[0]).map(r => [r.id, r.version, r.manifest, r.files, r.content_hash]));
        }
        if (/SELECT id, content_hash FROM widget_packages WHERE content_hash IS NOT NULL/.test(sql)) return result(['id', 'content_hash'], db.rows.filter(r => r.content_hash !== null).map(r => [r.id, r.content_hash]));
        if (/SELECT content_hash FROM widget_packages WHERE id = \?/.test(sql)) return result(['content_hash'], db.rows.filter(r => r.id === params[0]).map(r => [r.content_hash]));
        throw new Error(`unexpected query: ${sql}`);
      },
      async execute(sql: string, params: unknown[] = []) {
        if (/UPDATE widget_packages SET content_hash = \? WHERE id = \? AND content_hash IS NULL/.test(sql)) {
          const row = db.rows.find(r => r.id === params[1] && r.content_hash === null);
          if (row) row.content_hash = String(params[0]);
          return {};
        }
        throw new Error(`unexpected statement: ${sql}`);
      },
    },
  };
});

import { syncPackageFiles, getPackageFile, localCopies } from './materialize-db';
import { contentHashOf, currentCopy, hash16, readMaterializedFile } from './materialize';

const makeRow = (id: string, version: string, files: Record<string, string>, hashed = true): Pkg => {
  const manifest = JSON.stringify({ schema: 1, id, version });
  return { id, version, manifest, files: JSON.stringify(files), content_hash: hashed ? contentHashOf(manifest, files) : null };
};

let nodeA: string;
let nodeB: string;
beforeEach(() => {
  db.rows = [];
  nodeA = fs.mkdtempSync(path.join(os.tmpdir(), 'bosun-node-a-'));
  nodeB = fs.mkdtempSync(path.join(os.tmpdir(), 'bosun-node-b-'));
});
afterEach(() => {
  fs.rmSync(nodeA, { recursive: true, force: true });
  fs.rmSync(nodeB, { recursive: true, force: true });
});

describe('syncPackageFiles', () => {
  it('writes the packages of the database, then finds nothing to do', async () => {
    db.rows = [makeRow('alpha', '1.0.0', { 'scripts/a.sh': 'echo a\n' }), makeRow('beta', '1.0.0', { 'scripts/b.ps1': 'b\n' })];
    const first = await syncPackageFiles(nodeA);
    expect(first.written.sort()).toEqual(['alpha', 'beta']);
    expect(readMaterializedFile(nodeA, 'alpha', 'scripts/a.sh')).toBe('echo a\n');
    const second = await syncPackageFiles(nodeA);
    expect(second).toEqual({ written: [], removed: [], failed: [] });
  });

  it('gives a package from before the hash existed its hash, then writes it', async () => {
    db.rows = [makeRow('old', '1.0.0', { 'scripts/a.sh': 'echo\n' }, false)];
    expect(db.rows[0].content_hash).toBeNull();
    const r = await syncPackageFiles(nodeA);
    expect(db.rows[0].content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.written).toEqual(['old']);
  });

  it('picks up a changed package and removes one that was removed from the database', async () => {
    db.rows = [makeRow('alpha', '1.0.0', { 'scripts/a.sh': 'one\n' }), makeRow('beta', '1.0.0', { 'x.sh': 'x\n' })];
    await syncPackageFiles(nodeA);
    db.rows = [makeRow('alpha', '1.1.0', { 'scripts/a.sh': 'two\n' })];
    const r = await syncPackageFiles(nodeA);
    expect(r.written).toEqual(['alpha']);
    expect(r.removed).toEqual(['beta']);
    expect(readMaterializedFile(nodeA, 'alpha', 'scripts/a.sh')).toBe('two\n');
    expect(localCopies(nodeA)).toEqual(['alpha']);
  });

  it('keeps every node in step through the database alone: install on one, the other finds the files', async () => {
    db.rows = [makeRow('alpha', '1.0.0', { 'scripts/a.sh': 'v1\n' })];
    await syncPackageFiles(nodeA);                                    // node A has it, node B has not looked yet
    expect(localCopies(nodeB)).toEqual([]);
    await syncPackageFiles(nodeB);                                    // node B starts, or its timer fires
    expect(readMaterializedFile(nodeB, 'alpha', 'scripts/a.sh')).toBe('v1\n');
    db.rows = [makeRow('alpha', '2.0.0', { 'scripts/a.sh': 'v2\n' }), makeRow('gamma', '1.0.0', { 'g.sh': 'g\n' })];
    await syncPackageFiles(nodeA);
    await syncPackageFiles(nodeB);
    for (const node of [nodeA, nodeB]) {
      expect(readMaterializedFile(node, 'alpha', 'scripts/a.sh')).toBe('v2\n');
      expect(readMaterializedFile(node, 'gamma', 'g.sh')).toBe('g\n');
    }
    expect(currentCopy(nodeA, 'alpha')).toBe(currentCopy(nodeB, 'alpha'));
  });

  it('reports a package whose stored hash does not match its content, and still writes the others', async () => {
    const bad = makeRow('bad', '1.0.0', { 'scripts/a.sh': 'echo a\n' });
    bad.files = JSON.stringify({ 'scripts/a.sh': 'tampered\n' });     // changed behind the hash's back
    db.rows = [bad, makeRow('good', '1.0.0', { 'g.sh': 'g\n' })];
    const r = await syncPackageFiles(nodeA);
    expect(r.written).toEqual(['good']);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]).toMatchObject({ id: 'bad', error: expect.stringContaining('does not match') });
    expect(localCopies(nodeA)).toEqual(['good']);
  });

  it('refuses a package with an unsafe file name', async () => {
    db.rows = [makeRow('evil', '1.0.0', { '../escape.sh': 'x' })];
    const r = await syncPackageFiles(nodeA);
    expect(r.written).toEqual([]);
    expect(r.failed[0].error).toMatch(/unsafe/);
    expect(fs.readdirSync(nodeA)).toEqual([]);
  });
});

describe('getPackageFile', () => {
  it('reads from this node when it holds the current copy', async () => {
    db.rows = [makeRow('alpha', '1.0.0', { 'scripts/a.sh': 'echo a\n' })];
    await syncPackageFiles(nodeA);
    // Even if the database row's files were unreadable, the verified copy on disk is served.
    db.rows[0].files = 'not json';
    expect(await getPackageFile('alpha', 'scripts/a.sh', nodeA)).toBe('echo a\n');
  });

  it('falls back to the database when this node is behind or has nothing yet', async () => {
    db.rows = [makeRow('alpha', '1.0.0', { 'scripts/a.sh': 'old\n' })];
    await syncPackageFiles(nodeA);
    db.rows = [makeRow('alpha', '2.0.0', { 'scripts/a.sh': 'new\n' })];   // changed, node A has not synced yet
    expect(await getPackageFile('alpha', 'scripts/a.sh', nodeA)).toBe('new\n');
    expect(await getPackageFile('alpha', 'scripts/a.sh', nodeB)).toBe('new\n');   // a node with an empty folder
    expect(await getPackageFile('alpha', 'manifest.json', nodeB)).toContain('"version":"2.0.0"');
  });

  it('answers null for a package or file that does not exist', async () => {
    db.rows = [makeRow('alpha', '1.0.0', { 'a.sh': 'a\n' })];
    expect(await getPackageFile('nope', 'a.sh', nodeA)).toBeNull();
    expect(await getPackageFile('alpha', 'missing.sh', nodeA)).toBeNull();
  });
});

describe('the copy used is named by the hash', () => {
  it('CURRENT holds the first 16 characters of the content hash', async () => {
    db.rows = [makeRow('alpha', '1.0.0', { 'a.sh': 'a\n' })];
    await syncPackageFiles(nodeA);
    expect(currentCopy(nodeA, 'alpha')).toBe(hash16(db.rows[0].content_hash as string));
  });
});
