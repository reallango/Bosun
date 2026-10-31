import { describe, it, expect } from 'vitest';
import { typedParams, selectVariant, resolveScriptArgs } from './script-action';
import type { ActionVariant, ScriptSpec } from './spec-v2';

const script: ScriptSpec = {
  as: 'service', timeoutSec: 60, linux: 'a.sh',
  params: { name: { type: 'string', pattern: '^[a-z]+$', maxLength: 20 }, port: { type: 'number', min: 1, max: 65535, integer: true, default: 80 }, flag: { type: 'boolean' } },
};
const v = (over: Partial<ActionVariant> = {}): ActionVariant => ({ script: 's', args: {}, ...over });

describe('typedParams', () => {
  it('gives validated text back its declared type', () => {
    expect(typedParams({ a: { type: 'number', min: 0, max: 9, integer: true }, b: { type: 'boolean' }, c: { type: 'string', maxLength: 5 } }, { a: '4', b: 'true', c: 'x' }))
      .toEqual({ a: 4, b: true, c: 'x' });
  });
});

describe('selectVariant', () => {
  const action = { variants: [
    v({ script: 'docker', when: { field: 'state.install.kind', equals: 'docker' } }),
    v({ script: 'service', when: { all: [{ field: 'state.install.kind', equals: 'service' }, { field: 'server.platform', equals: 'linux' }] } }),
    v({ script: 'fallback' }),
  ] };
  it('takes the first whose condition holds', () => {
    expect(selectVariant(action, { state: { install: { kind: 'docker' } } })?.script).toBe('docker');
    expect(selectVariant(action, { state: { install: { kind: 'service' } }, server: { platform: 'linux' } })?.script).toBe('service');
  });
  it('a variant without a condition is the fallback', () => {
    expect(selectVariant(action, { state: { install: { kind: 'service' } }, server: { platform: 'windows' } })?.script).toBe('fallback');
  });
  it('is null when nothing applies', () => {
    expect(selectVariant({ variants: [v({ when: { field: 'state.x', equals: 1 } })] }, {})).toBeNull();
    expect(selectVariant({ variants: [] }, {})).toBeNull();
    expect(selectVariant({}, {})).toBeNull();
  });
});

describe('resolveScriptArgs with script defaults', () => {
  it('uses the default of a parameter that nothing supplies', () => {
    const s: ScriptSpec = { ...script, params: { exe: { type: 'string', pattern: '^.*$', maxLength: 20, default: 'C:\\x\\ollama.exe' } } };
    expect(resolveScriptArgs(v({ args: {} }), s, {}).exe).toBe('C:\\x\\ollama.exe');
  });
});

describe('resolveScriptArgs', () => {
  it('reads context paths, literals and action parameters of the same name', () => {
    const variant = v({ args: { name: 'state.install.name', port: 'param.port' } });
    const out = resolveScriptArgs(variant, script, { state: { install: { name: 'ollama' } }, param: { port: 8080, flag: true } });
    expect(out).toEqual({ name: 'ollama', port: 8080, flag: true });   // port from param.port, flag from the action parameter of the same name
  });
  it('literal text', () => {
    expect(resolveScriptArgs(v({ args: { name: 'literal:docker' } }), script, {}).name).toBe('docker');
  });
  it('falls back to the script default, and leaves a required value out when nothing supplies it', () => {
    const out = resolveScriptArgs(v({ args: { name: 'state.missing' } }), script, {});
    expect(out).toEqual({ port: 80 });
  });
  it('turns a number or boolean from the context into text for a text parameter', () => {
    const s: ScriptSpec = { ...script, params: { name: { type: 'string', pattern: '^.*$', maxLength: 9 } } };
    expect(resolveScriptArgs(v({ args: { name: 'state.n' } }), s, { state: { n: 12 } }).name).toBe('12');
    expect(resolveScriptArgs(v({ args: { name: 'state.b' } }), s, { state: { b: true } }).name).toBe('true');
  });
  it('cannot reach outside the context', () => {
    expect(resolveScriptArgs(v({ args: { name: 'process.env.PATH' } }), script, {}).name).toBeUndefined();
    expect(resolveScriptArgs(v({ args: { name: 'state.__proto__.x' } }), script, { state: {} }).name).toBeUndefined();
  });
});
