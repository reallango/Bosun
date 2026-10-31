import { describe, it, expect } from 'vitest';
import { validateManifest } from './package-manifest';
import { buildScriptInvocation } from './runtime/script-run';

const manifest = (): any => ({
  schema: 1, id: 'sec_pkg', name: 'Sec', version: '1.0.0', description: 'd', author: 'a',
  secrets: [{ id: 'git_token', label: 'Git token', description: 'for private repos' }],
  permissions: [{ id: 'sec_pkg.view', label: 'v', description: 'v', group: 'g', defaultLevel: 'viewer', risk: 'low', scope: 'server' }],
  widgets: [{
    type: 'sec_widget', display_name: 'S', description: 'x', default_size: { w: 4, h: 3 },
    spec: { version: 2, scripts: { run: { as: 'service', timeoutSec: 30, linux: 'scripts/run.sh', secrets: ['git_token'] } }, data: { source: 'snapshot', section: 'services', permission: 'sec_pkg.view' }, view: { type: 'text', text: 'x' } },
  }],
});
const bad = (mut: (m: any) => void) => { const m = manifest(); mut(m); return validateManifest(m); };

describe('package secrets', () => {
  it('are declared in the manifest and named by the scripts that need them', () => {
    const r = validateManifest(manifest());
    if (!r.ok) throw new Error(r.error);
    expect(r.value.secrets).toEqual([{ id: 'git_token', label: 'Git token', description: 'for private repos' }]);
    expect(bad(m => { m.widgets[0].spec.scripts.run.secrets = ['other']; }).ok).toBe(false);          // not declared
    expect(bad(m => { m.secrets.push({ id: 'git_token', label: 'again' }); }).ok).toBe(false);         // twice
    expect(bad(m => { m.secrets[0].id = 'Bad-Id'; }).ok).toBe(false);
    expect(bad(m => { m.widgets[0].spec.scripts.run.windows = 'scripts/run.ps1'; }).ok).toBe(false);  // no Windows file for a script with secrets
  });

  it('reach the script on stdin, never on the command line, and not on Windows', () => {
    const inv = buildScriptInvocation('linux', '#!/bin/sh\necho hi\n', { name: 'x' }, { secrets: { git_token: "to'ken value" } });
    expect(inv.command).not.toContain('token');
    expect(inv.command).not.toContain('BOSUN_SECRET');
    expect(inv.stdin).toBe("export BOSUN_SECRET_git_token='to'\\''ken value'\n#!/bin/sh\necho hi\n");   // one quoted word, the quote inside it escaped
    expect(() => buildScriptInvocation('windows', 'echo hi', {}, { secrets: { git_token: 'x' } })).toThrow(/Windows/);
    expect(buildScriptInvocation('linux', 'echo hi', {}).stdin).toBe('echo hi');
  });
});
