import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/db/rqlite-client', () => ({ rqlite: {}, rowsToObjects: () => [] }));

import { asRootCommand } from './admin-exec';

const decode = (cmd: string) => Buffer.from(/printf %s '([A-Za-z0-9+/=]+)'/.exec(cmd)![1], 'base64').toString();

describe('asRootCommand', () => {
  it('sends the sudo password on stdin, never on the command line, and closes the script\'s stdin', () => {
    const r = asRootCommand({ host: 'h', port: 22, username: 'admin', password: 'pw' }, "s3cr'et", 'id -u');
    expect(r.command).toMatch(/^sudo -S -p '' sh -c /);
    expect(r.command).not.toContain("s3cr'et");
    expect(r.stdin).toBe("s3cr'et\n");
    expect(decode(r.command)).toBe('exec </dev/null\nid -u');
  });

  it('runs directly for root', () => {
    const r = asRootCommand({ host: 'h', port: 22, username: 'root', password: 'pw' }, 'pw', 'true');
    expect(r.command.startsWith('sh -c ')).toBe(true);
    expect(r.stdin).toBe('');
  });
});
