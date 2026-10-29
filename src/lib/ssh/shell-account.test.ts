import { describe, it, expect } from 'vitest';
import { ADMIN_LIKE_GROUPS, SHELL_ACCOUNT_RE, SHELL_VERIFY_COMMAND, parseShellVerification, shellAccountScript } from './shell-account';

const opts = { account: 'bosun-user', privilegedAccount: 'bosun-svc', publicKey: 'ssh-ed25519 AAAAC3NzaC1 host-bosun-user', replaceKeys: true };

describe('shellAccountScript', () => {
  it('never grants sudo, and removes admin-like groups', () => {
    const s = shellAccountScript(opts);
    expect(s).not.toMatch(/NOPASSWD|sudoers|visudo/i);
    expect(s).not.toMatch(/useradd[^\n]*-G/);                       // not created into any group
    for (const g of ADMIN_LIKE_GROUPS) expect(s).toContain(g);
    expect(s).toContain('gpasswd -d "$U"');
  });

  it('locks the password so only the key works', () => {
    expect(shellAccountScript(opts)).toContain('passwd -l "$U"');
  });

  it('closes the admin account home to other users', () => {
    expect(shellAccountScript(opts)).toContain('chmod go-rwx "$ph"');
  });

  it('forbids forwarding and tunnelling for the account in sshd, and validates before reloading', () => {
    const s = shellAccountScript(opts);
    for (const d of ['AllowTcpForwarding no', 'AllowAgentForwarding no', 'AllowStreamLocalForwarding no', 'X11Forwarding no', 'PermitTunnel no', 'GatewayPorts no']) {
      expect(s).toContain(d);
    }
    expect(s.indexOf('-t >/dev/null')).toBeGreaterThan(-1);          // sshd -t first
    expect(s.indexOf('-t >/dev/null')).toBeLessThan(s.indexOf('BOSUN_SSHD_RESTRICTED'));
    expect(s).toContain('rm -f "$f"; echo BOSUN_SSHD_UNCHANGED');    // a config that does not validate is removed
  });

  it('replaces or appends the key as asked', () => {
    expect(shellAccountScript(opts)).toContain(`printf '%s\\n' "$KEY" > "$ak"`);
    const append = shellAccountScript({ ...opts, replaceKeys: false });
    expect(append).toContain('grep -qxF');
    expect(append).not.toMatch(/[^>]> "$ak"/);
  });

  it('quotes values safely and ends with the success marker', () => {
    const s = shellAccountScript({ ...opts, publicKey: `ssh-ed25519 AAAA host'; rm -rf / #` });
    expect(s).toContain(`KEY='ssh-ed25519 AAAA host'\\''; rm -rf / #'`);
    expect(s.trim().endsWith('echo BOSUN_SHELL_OK')).toBe(true);
  });
});

describe('SHELL_ACCOUNT_RE', () => {
  it('accepts ordinary unix account names and rejects anything that could be an injection', () => {
    for (const ok of ['bosun-user', 'svc_shell', 'a', 'x1']) expect(SHELL_ACCOUNT_RE.test(ok)).toBe(true);
    for (const bad of ['Root', '1abc', '-x', 'a b', 'a;b', 'a$(id)', 'a'.repeat(21), '', 'a.b']) expect(SHELL_ACCOUNT_RE.test(bad)).toBe(false);
  });
});

describe('parseShellVerification', () => {
  const clean = 'WHOAMI bosun-user\nUID 1002\nGROUPS bosun-user users\nSUDO_NO\nDOCKER_SOCKET_NO\n';

  it('accepts an account with no admin rights', () => {
    expect(parseShellVerification(clean, 'bosun-user')).toEqual({ ok: true, problems: [] });
  });

  it('flags passwordless sudo', () => {
    const r = parseShellVerification(clean.replace('SUDO_NO', 'SUDO_OK'), 'bosun-user');
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toMatch(/sudo/);
  });

  it('flags admin-like groups, naming them', () => {
    const r = parseShellVerification(clean.replace('GROUPS bosun-user users', 'GROUPS bosun-user docker sudo'), 'bosun-user');
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toMatch(/docker, sudo groups/);
  });

  it('flags root, the Docker socket, and logging in as someone else', () => {
    expect(parseShellVerification(clean.replace('UID 1002', 'UID 0'), 'bosun-user').problems.join(' ')).toMatch(/root/);
    expect(parseShellVerification(clean.replace('DOCKER_SOCKET_NO', 'DOCKER_SOCKET_OK'), 'bosun-user').problems.join(' ')).toMatch(/Docker socket/);
    expect(parseShellVerification(clean.replace('WHOAMI bosun-user', 'WHOAMI bosun-svc'), 'bosun-user').problems.join(' ')).toMatch(/not "bosun-user"/);
  });

  it('treats missing output as a problem: unknown is never "safe"', () => {
    const r = parseShellVerification('', 'bosun-user');
    expect(r.ok).toBe(false);
    expect(r.problems.length).toBeGreaterThanOrEqual(3);
  });

  it('the verification command checks everything the parser reads', () => {
    for (const marker of ['WHOAMI', 'UID', 'GROUPS', 'SUDO_OK', 'SUDO_NO', 'DOCKER_SOCKET_OK', 'DOCKER_SOCKET_NO']) {
      expect(SHELL_VERIFY_COMMAND).toContain(marker);
    }
  });
});
