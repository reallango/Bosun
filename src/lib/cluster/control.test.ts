import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { encodeJoinCode, decodeJoinCode, type JoinCode } from './control';
import { isValidAddr, isValidHost, isValidNodeId } from './config';

const sample = (over: Partial<JoinCode> = {}): JoinCode => ({
  v: 1,
  exp: Date.now() + 60_000,
  members: [{ id: 'node1', raft: '192.168.1.20:4002' }],
  mk: 'mk',
  as: 'as',
  ...over,
});

describe('join codes', () => {
  it('round-trips and tolerates line breaks from copy/paste', () => {
    const code = encodeJoinCode(sample());
    expect(code.startsWith('BOSUN-JOIN-1.')).toBe(true);
    const wrapped = code.slice(0, 20) + '\n  ' + code.slice(20);
    expect(decodeJoinCode(wrapped).members[0].raft).toBe('192.168.1.20:4002');
  });
  it('rejects foreign, damaged, expired and malformed codes', () => {
    expect(() => decodeJoinCode('hello')).toThrow(/Not a Bosun join code/);
    expect(() => decodeJoinCode('BOSUN-JOIN-1.%%%')).toThrow();
    expect(() => decodeJoinCode(encodeJoinCode(sample({ exp: Date.now() - 1 })))).toThrow(/expired/);
    expect(() => decodeJoinCode(encodeJoinCode(sample({ members: [] })))).toThrow(/incomplete/);
    expect(() => decodeJoinCode(encodeJoinCode(sample({ members: [{ id: 'x', raft: 'evil;rm -rf /:4002' }] })))).toThrow(/invalid member/);
  });
  it('carries a 400 status for the API', () => {
    try { decodeJoinCode('nope'); } catch (e) { expect((e as { status?: number }).status).toBe(400); }
  });
});

describe('cluster settings validation', () => {
  it('accepts hosts, addresses and node ids, rejects shell metacharacters', () => {
    expect(isValidHost('192.168.1.20')).toBe(true);
    expect(isValidHost('bosun-1.lan')).toBe(true);
    expect(isValidHost("a';reboot")).toBe(false);
    expect(isValidAddr('bosun-1.lan:4002')).toBe(true);
    expect(isValidAddr('bosun-1.lan:99999')).toBe(false);
    expect(isValidNodeId('node_2.a-b')).toBe(true);
    expect(isValidNodeId('-x')).toBe(false);
    expect(isValidNodeId('a b')).toBe(false);
  });
});

describe('boot.js (rqlite start)', () => {
  let dir: string;
  const boot = (env: Record<string, string> = {}) => execFileSync(process.execPath, [path.join(__dirname, 'boot.js')], {
    env: { NODE_ENV: 'test', PATH: process.env.PATH || '', RQLITE_DATA_DIR: dir, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const file = () => path.join(dir, 'bosun', 'cluster.json');
  const write = (o: unknown) => { fs.mkdirSync(path.dirname(file()), { recursive: true }); fs.writeFileSync(file(), JSON.stringify(o)); };
  const read = () => JSON.parse(fs.readFileSync(file(), 'utf8'));

  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bosun-boot-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('prints environment defaults without a settings file', () => {
    const out = boot({ NODE_NAME: 'n1', RQLITE_ADV_HOST: 'h1', RQLITE_JOIN: 'a:4002,b:4002' });
    expect(out).toContain("BOSUN_NODE_ID='n1'");
    expect(out).toContain("BOSUN_ADV_HOST='h1'");
    expect(out).toContain("BOSUN_JOIN='a:4002,b:4002'");
  });

  it('settings file wins over the environment', () => {
    write({ node_id: 'ui-node', adv_host: '10.0.0.5', join: [] });
    const out = boot({ NODE_NAME: 'n1', RQLITE_ADV_HOST: 'h1', RQLITE_JOIN: 'a:4002' });
    expect(out).toContain("BOSUN_NODE_ID='ui-node'");
    expect(out).toContain("BOSUN_ADV_HOST='10.0.0.5'");
    expect(out).toContain("BOSUN_JOIN=''");
  });

  it('readdress rewrites the Raft membership once', () => {
    fs.mkdirSync(path.join(dir, 'raft'), { recursive: true });
    write({ node_id: 'n1', adv_host: '10.0.0.5', join: [], pending: 'readdress' });
    boot();
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'raft', 'peers.json'), 'utf8')))
      .toEqual([{ id: 'n1', address: '10.0.0.5:4002', non_voter: false }]);
    expect(read().pending).toBeNull();
    expect(read().last_action.action).toBe('readdress');
  });

  it('wipe_and_join clears the database but keeps settings and secrets', () => {
    fs.mkdirSync(path.join(dir, 'raft'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'db.sqlite'), 'x');
    write({ node_id: 'n2', adv_host: '10.0.0.6', join: ['10.0.0.5:4002'], pending: 'wipe_and_join' });
    fs.writeFileSync(path.join(dir, 'bosun', 'secrets.json'), '{}');
    const out = boot({ RQLITE_BOOTSTRAP_EXPECT: '3' });
    expect(fs.readdirSync(dir)).toEqual(['bosun']);
    expect(fs.existsSync(path.join(dir, 'bosun', 'secrets.json'))).toBe(true);
    expect(out).toContain("BOSUN_JOIN='10.0.0.5:4002'");
    expect(out).toContain("BOSUN_EXPECT=''");
    expect(read().pending).toBeNull();
  });

  it('quotes values safely for the shell', () => {
    // Invalid values cannot be written through the UI, but the output is quoted regardless.
    write({ node_id: "it's" });
    expect(boot()).toContain(`BOSUN_NODE_ID='it'\\''s'`);
  });
});
