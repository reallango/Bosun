import { describe, it, expect } from 'vitest';
import { applyPullLine, assertModelName, ollamaApiCommand, PullJob } from './actions';

const job = (): PullJob => ({
  id: 'j', serverId: 's', model: 'm', status: 'running', phase: 'starting', completed: 0, total: 0,
  percent: null, error: null, startedAt: 0, finishedAt: null, startedBy: 'u',
});

describe('ollama pull progress', () => {
  it('tracks download progress and success', () => {
    const j = job();
    applyPullLine(j, '{"status":"pulling manifest"}');
    expect(j.phase).toBe('pulling manifest');
    applyPullLine(j, '{"status":"pulling abc","total":200,"completed":50}');
    expect(j.percent).toBe(25);
    applyPullLine(j, '{"status":"success"}');
    applyPullLine(j, 'HTTP_STATUS=200');
    expect(j.status).toBe('success');
    expect(j.percent).toBe(100);
  });
  it('reports API errors and HTTP failures', () => {
    const a = job();
    applyPullLine(a, '{"error":"pull model manifest: file does not exist"}');
    expect(a).toMatchObject({ status: 'error', error: 'pull model manifest: file does not exist' });
    const b = job();
    applyPullLine(b, 'not json');
    applyPullLine(b, 'HTTP_STATUS=500');
    expect(b).toMatchObject({ status: 'error', error: 'HTTP 500' });
  });
});

describe('model name validation and command building', () => {
  it('accepts registry names and rejects shell metacharacters', () => {
    expect(() => assertModelName('llama3.2:1b')).not.toThrow();
    expect(() => assertModelName('hf.co/org/model:Q4_K_M')).not.toThrow();
    for (const bad of ['', 'a b', "x';rm -rf /;'", '../etc', 'a$(id)', 'a`id`']) {
      expect(() => assertModelName(bad)).toThrow();
    }
  });
  it('quotes the JSON body for sh and passes it via a temp file on Windows', () => {
    const linux = ollamaApiCommand('linux', 'DELETE', '/api/delete', { name: 'tiny:1b' }, false);
    expect(linux).toContain(`--data-binary '{"name":"tiny:1b"}'`);
    expect(linux).toContain('http://127.0.0.1:11434/api/delete');
    const win = ollamaApiCommand('windows', 'POST', '/api/pull', { name: 'tiny:1b' }, true);
    const script = Buffer.from(win.split(' ').pop() as string, 'base64').toString('utf16le');
    expect(script).toContain(`WriteAllText($f, '{"name":"tiny:1b"}')`);
    expect(script).toContain('curl.exe -s -N');
  });
});
