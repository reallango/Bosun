import { describe, it, expect } from 'vitest';
import { adaptCopiedCompose, envText, gitSourceOf, mergeComposeExports } from './import-spec';
import { normalizeUrl } from './client';

describe('turning a Portainer stack into a Bosun stack', () => {
  it('writes Portainer variables as .env lines and leaves out what .env cannot hold', () => {
    const notes: string[] = [];
    expect(envText([{ name: 'A', value: '1' }, { name: 'B_2', value: 'x y=z' }, { name: 'bad-name', value: '1' }, { name: 'C', value: 'two\nlines' }], notes)).toBe('A=1\nB_2=x y=z\n');
    expect(notes).toHaveLength(2);
    expect(envText(null, [])).toBe('');
  });

  it('maps a git stack to a branch and file, and falls back to copying for what Bosun cannot fetch', () => {
    const notes: string[] = [];
    expect(gitSourceOf({ URL: 'https://github.com/reallango/Bosun.git', ReferenceName: 'refs/heads/main', ConfigFilePath: 'docker-compose.cluster.yaml' }, notes))
      .toEqual({ repo: 'https://github.com/reallango/Bosun', branch: 'main', file: 'docker-compose.cluster.yaml' });
    expect(gitSourceOf({ URL: 'https://git.lan:3000/o/r', ReferenceName: 'refs/heads/dev', ConfigFilePath: './deploy/compose.yml' }, notes))
      .toEqual({ repo: 'https://git.lan:3000/o/r', branch: 'dev', file: 'deploy/compose.yml' });
    expect(notes).toEqual([]);
    expect(gitSourceOf({ URL: 'git@github.com:o/r.git', ReferenceName: 'refs/heads/main', ConfigFilePath: 'c.yml' }, notes)).toBeNull();
    expect(gitSourceOf({ URL: 'https://github.com/o/r', ReferenceName: 'refs/tags/v1..x', ConfigFilePath: 'c.yml' }, notes)).toBeNull();
    expect(gitSourceOf({ URL: 'https://github.com/o/r', ReferenceName: 'refs/heads/main', ConfigFilePath: '../etc/x' }, notes)).toBeNull();
    expect(gitSourceOf(null, notes)).toBeNull();
    expect(notes).toHaveLength(3);
  });

  it('points Portainer\'s stack.env at .env and warns about relative paths', () => {
    const notes: string[] = [];
    expect(adaptCopiedCompose('services:\n  a:\n    image: x\n    env_file:\n      - stack.env\n', notes)).toBe('services:\n  a:\n    image: x\n    env_file:\n      - .env\n');
    expect(adaptCopiedCompose('services:\n  a:\n    env_file: ./stack.env\n', [])).toBe('services:\n  a:\n    env_file: .env\n');
    adaptCopiedCompose('services:\n  a:\n    build: .\n', notes);
    expect(notes).toHaveLength(2);
  });

  it('merges one-container exports under the services Compose knew, with volumes and networks once', () => {
    const notes: string[] = [];
    const web = '# Not exported: the compose labels com.docker.compose.*\nservices:\n  app-web-1:\n    image: "nginx"\n    container_name: "app-web-1"\n    volumes:\n      - "app_data:/d"\nvolumes:\n  app_data:\n    external: true\nnetworks:\n  app_default:\n    external: true\n';
    const db = 'services:\n  app-db-1:\n    image: "postgres"\n    networks:\n      app_default: {}\nnetworks:\n  app_default:\n    external: true\n';
    expect(mergeComposeExports([{ service: 'web', text: web }, { service: 'db', text: db }], notes)).toBe([
      'services:',
      '  web:', '    image: "nginx"', '    container_name: "app-web-1"', '    volumes:', '      - "app_data:/d"',
      '  db:', '    image: "postgres"', '    networks:', '      app_default: {}',
      'volumes:', '  app_data:', '    external: true',
      'networks:', '  app_default:', '    external: true',
    ].join('\n') + '\n');
    expect(notes).toEqual(['web: not carried over: the compose labels com.docker.compose.*']);
  });

  it('accepts only plain http(s) Portainer addresses', () => {
    expect(normalizeUrl('https://192.168.1.160:9443/')).toBe('https://192.168.1.160:9443');
    expect(normalizeUrl('http://portainer.lan')).toBe('http://portainer.lan');
    for (const bad of ['ftp://x', 'https://u:p@x', 'https://x/?a=1', 'not a url', 5]) expect(normalizeUrl(bad), String(bad)).toBeNull();
  });
});
