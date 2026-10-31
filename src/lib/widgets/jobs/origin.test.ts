import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/secrets', () => ({ getMasterKey: () => 'test-master-key-test-master-key-1234' }));
vi.mock('@/lib/crypto/keys', () => ({ encrypt: (s: string) => Buffer.from(s).toString('base64'), decrypt: (s: string) => Buffer.from(s, 'base64').toString() }));

import { decryptOrigin, editorFieldsOf, encryptOrigin, maskValues, resolveTokens, sanitizeOrigin } from './origin';
import type { EditorField } from '../runtime/spec-v2';
import type { ScreenSpec } from '../runtime/spec-screens';

const fields: EditorField[] = [
  { name: 'env', label: 'Env', input: 'pairs', mask: 'secret-names' },
  { name: 'dotenv', label: '.env', input: 'textarea', mask: 'secret-names' },
  { name: 'label', label: 'Labels', input: 'pairs' },
];

describe('what a task remembers', () => {
  it('takes the values of secret-looking names out, keeps the rest, and puts them back on the server', () => {
    const values = { env: ['DB_PASSWORD=hunter2', 'MODE=prod', 'API_TOKEN=abc123'], dotenv: 'REDIS_URL=redis://x\nSECRET_KEY=s3cret\n', label: ['PASSWORD=not-masked-here'] };
    const m = maskValues(fields, values);
    expect(m.values.env).toEqual(['DB_PASSWORD=bosun-saved:0', 'MODE=prod', 'API_TOKEN=bosun-saved:1']);
    expect(m.values.dotenv).toBe('REDIS_URL=redis://x\nSECRET_KEY=bosun-saved:2\n');
    expect(m.values.label).toEqual(['PASSWORD=not-masked-here']);   // only fields that ask for it are masked
    expect(m.secrets).toEqual(['hunter2', 'abc123', 's3cret']);
    expect(JSON.stringify(m.values)).not.toMatch(/hunter2|abc123|s3cret/);
    expect(resolveTokens(m.values, m.secrets)).toEqual(values);
    // masking again (a reopened screen submitted without changes) does not mask a placeholder twice
    expect(maskValues(fields, m.values, m.secrets).secrets).toEqual(m.secrets);
  });

  it('refuses a placeholder whose saved value is gone', () => {
    expect(() => resolveTokens({ a: 'X=bosun-saved:7' }, ['one'])).toThrow(/no longer available/);
  });

  it('encrypts the origin and reads it back; garbage reads as nothing', () => {
    const origin = { screenId: 'edit', context: { name: 'web' }, values: { env: ['A=bosun-saved:0'] }, secrets: ['pw'] };
    const enc = encryptOrigin(origin);
    expect(enc).not.toContain('"web"');
    expect(decryptOrigin(enc)).toEqual(origin);
    expect(decryptOrigin('not base64 json')).toBeNull();
    expect(decryptOrigin(null)).toBeNull();
  });

  it('checks and bounds what the browser sends', () => {
    expect(sanitizeOrigin({ screenId: 'edit', context: { name: 'web' }, values: { a: 1 } })).toEqual({ screenId: 'edit', context: { name: 'web' }, values: { a: 1 } });
    expect(sanitizeOrigin({ screenId: 'Bad Id', values: {} })).toBeNull();
    expect(sanitizeOrigin({ screenId: 'edit', values: 'nope' })).toBeNull();
    expect(sanitizeOrigin({ screenId: 'edit', values: { big: 'x'.repeat(130_000) } })).toBeNull();
    expect(sanitizeOrigin(null)).toBeNull();
  });

  it('finds the editor fields of a screen, in tabs and sections too', () => {
    const screen = { kind: 'dialog', title: 't', size: 'lg', load: {}, keepOpenAfterSubmit: false, blocks: [{ type: 'tabs', tabs: [{ id: 'a', label: 'A', blocks: [{ type: 'editor', fields, submits: [] }] }] }] } as unknown as ScreenSpec;
    expect(editorFieldsOf(screen).map(f => f.name)).toEqual(['env', 'dotenv', 'label']);
    expect(editorFieldsOf(undefined)).toEqual([]);
  });
});
