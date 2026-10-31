import { describe, it, expect } from 'vitest';
import { applyFill, datasetArgsFromForm, editorInitial, editorMissing, formatRow, hiddenByHeading, parseRowLine, remoteOptions, serializeEditor } from './layout';
import type { EditorField } from './spec-v2';

const ports: EditorField = {
  name: 'port', label: 'Ports', input: 'rows',
  columns: [
    { name: 'host_ip', label: 'Address', input: 'text' }, { name: 'host_port', label: 'Host', input: 'number' },
    { name: 'container_port', label: 'Container', input: 'number' }, { name: 'protocol', label: 'Protocol', input: 'select', options: [{ value: 'tcp', label: 'TCP' }, { value: 'udp', label: 'UDP' }], default: 'tcp' },
  ],
  format: [{ col: 'host_ip', suffix: ':', optional: true }, { col: 'host_port', suffix: ':' }, { col: 'container_port' }, { col: 'protocol', prefix: '/' }],
  parse: '^(?:(?<host_ip>[0-9a-fA-F:.]+?):)?(?<host_port>[0-9]+):(?<container_port>[0-9]+)(?:/(?<protocol>tcp|udp))?$',
};
const volumes: EditorField = {
  name: 'volume', label: 'Volumes', input: 'rows',
  columns: [
    { name: 'type', label: 'Type', input: 'select', options: [{ value: 'volume', label: 'Volume' }, { value: 'folder', label: 'Folder' }], default: 'volume' },
    { name: 'source', label: 'Source', input: 'text' }, { name: 'target', label: 'Container path', input: 'text' },
    { name: 'mode', label: 'Access', input: 'select', options: [{ value: 'rw', label: 'Read/write' }, { value: 'ro', label: 'Read only' }], default: 'rw' },
  ],
  format: [{ col: 'source', suffix: ':' }, { col: 'target' }, { col: 'mode', prefix: ':', omit: ['rw'] }],
  parse: '^(?<source>[^:]+):(?<target>[^:]+)(?::(?<mode>ro|rw))?$',
  derive: { type: { from: 'source', startsWith: '/', then: 'folder', else: 'volume' } },
};

describe('rows fields', () => {
  it('read a stored line into labelled columns and write it back', () => {
    expect(parseRowLine(ports, '127.0.0.1:8081:80/udp')).toEqual({ host_ip: '127.0.0.1', host_port: '8081', container_port: '80', protocol: 'udp' });
    expect(parseRowLine(ports, '8081:80')).toEqual({ host_ip: '', host_port: '8081', container_port: '80', protocol: 'tcp' });   // the protocol defaults
    expect(parseRowLine(ports, 'not a port')).toBeNull();
    expect(formatRow(ports, { host_ip: '', host_port: '8081', container_port: '80', protocol: 'tcp' })).toBe('8081:80/tcp');
    expect(formatRow(ports, { host_ip: '127.0.0.1', host_port: '8081', container_port: '80', protocol: 'udp' })).toBe('127.0.0.1:8081:80/udp');
    expect(formatRow(ports, { host_ip: '', host_port: '', container_port: '', protocol: 'tcp' })).toBeNull();   // nothing typed: the row is dropped
  });

  it('derive a column and leave out values the host assumes', () => {
    expect(parseRowLine(volumes, '/srv/data:/data:ro')).toEqual({ type: 'folder', source: '/srv/data', target: '/data', mode: 'ro' });
    expect(parseRowLine(volumes, 'my-vol:/data')).toEqual({ type: 'volume', source: 'my-vol', target: '/data', mode: 'rw' });
    expect(formatRow(volumes, { type: 'volume', source: 'my-vol', target: '/data', mode: 'rw' })).toBe('my-vol:/data');
    expect(formatRow(volumes, { type: 'folder', source: '/srv/a', target: '/a', mode: 'ro' })).toBe('/srv/a:/a:ro');
  });

  it('round-trip through the editor values and the settings blob; a row cannot add a line', () => {
    const withPath = [{ ...ports, value: 'cur.port' }, { ...volumes, value: 'cur.volume' }];
    const filled = editorInitial(withPath, { cur: { port: ['8081:80/tcp'], volume: ['demo:/x:ro'] } } as never);
    expect(serializeEditor(withPath, filled)).toBe('port=8081:80/tcp\nvolume=demo:/x:ro');
    (filled.port as Record<string, string>[]).push({ host_ip: '', host_port: '9\nvolume=/etc:/etc', container_port: '1', protocol: 'tcp' });
    expect(serializeEditor(withPath, filled).split('\n').filter(l => l.startsWith('volume=')).length).toBe(1);
  });
});

describe('fill from the host, collapsed groups and remote options', () => {
  const fields: EditorField[] = [
    { name: 'h_import', label: 'Import', input: 'heading', collapsed: true },
    { name: 'import_text', label: 'Paste', input: 'textarea', transient: true },
    { name: 'h_main', label: 'Main', input: 'heading' },
    { name: 'image', label: 'Image', input: 'text', required: true },
    ports,
    { name: 'tty', label: 'TTY', input: 'checkbox' },
    { name: 'env', label: 'Env', input: 'pairs' },
  ];

  it('hides what sits under a closed heading, and never sends transient fields', () => {
    expect(Array.from(hiddenByHeading(fields, new Set()))).toEqual(['import_text']);
    expect(Array.from(hiddenByHeading(fields, new Set(['h_import'])))).toEqual([]);
    const values = { ...editorInitial(fields, {}), import_text: 'docker run nginx', image: 'nginx' };
    expect(serializeEditor(fields, values)).toBe('image=nginx\ntty=false');
    expect(editorMissing(fields, { ...values, image: '' })).toEqual(['Image']);
  });

  it('applies what the host answered by field key and reports keys it does not know', () => {
    const values = editorInitial(fields, {});
    const r = applyFill(fields, values, { image: 'nginx:alpine', port: ['8080:80/tcp'], tty: 'true', env: ['A=1'], bogus: 'x' }, {});
    expect(r.values.image).toBe('nginx:alpine');
    expect(r.values.port).toEqual([{ host_ip: '', host_port: '8080', container_port: '80', protocol: 'tcp' }]);
    expect(r.values.tty).toBe(true);
    expect(r.values.env).toEqual(['A=1']);
    expect(r.unknown).toEqual(['bogus']);
  });

  it('builds remote select options and arguments from the form', () => {
    const f: EditorField = { name: 'branch', label: 'Branch', input: 'select', remote: { dataset: 'git_branches', args: { repo: 'values.repo' }, path: 'items', value: 'name' } };
    expect(remoteOptions(f, { items: [{ name: 'main' }, { name: 'dev' }] })).toEqual([{ value: 'main', label: 'main' }, { value: 'dev', label: 'dev' }]);
    expect(remoteOptions({ ...f, remote: { dataset: 'git_files', args: {}, path: 'items' } }, { items: ['a.yml', 'b.yml'] })).toEqual([{ value: 'a.yml', label: 'a.yml' }, { value: 'b.yml', label: 'b.yml' }]);
    expect(datasetArgsFromForm({ repo: 'values.repo' }, { repo: '' }, {})).toEqual({ args: {}, missing: ['values.repo'] });
    expect(datasetArgsFromForm({ repo: 'values.repo', k: 'literal:x' }, { repo: 'https://github.com/a/b' }, {})).toEqual({ args: { repo: 'https://github.com/a/b', k: 'x' }, missing: [] });
  });
});
