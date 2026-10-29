import { describe, it, expect } from 'vitest';
import { windowsShellAccountScript, WINDOWS_SHELL_VERIFY_COMMAND, parseWindowsShellVerification, WINDOWS_ADMIN_LIKE_SIDS } from './windows-shell-account';

const opts = { account: 'bosun-user', publicKey: 'ssh-ed25519 AAAAC3NzaC1 host-bosun-user', replaceKeys: true };

describe('windowsShellAccountScript', () => {
  const s = windowsShellAccountScript(opts);

  it('creates a plain local account with a random password that is never in the script', () => {
    expect(s).toContain('New-LocalUser');
    expect(s).toContain('RandomNumberGenerator');
    expect(s).not.toMatch(/ConvertTo-SecureString '[^']/);   // the secret is generated on the host, not sent
  });

  it('removes the account from every administrator-like group and never adds it to Administrators', () => {
    for (const sid of WINDOWS_ADMIN_LIKE_SIDS) expect(s).toContain(`'${sid}'`);
    expect(s).toContain('Remove-LocalGroupMember');
    expect(s).not.toMatch(/Add-LocalGroupMember[^\n]*544/);
    expect(s).toContain("Get-LocalGroup -SID 'S-1-5-32-545'");     // Users
  });

  it('creates a real profile and locks the key file to the account, SYSTEM and Administrators', () => {
    expect(s).toContain('CreateProfile');
    expect(s).toContain('SetAccessRuleProtection($true, $false)');
    expect(s).toContain("'S-1-5-18'");
    expect(s).toContain('authorized_keys');
  });

  it('forbids forwarding in sshd, validates the config and restores it if it does not validate', () => {
    for (const d of ['AllowTcpForwarding no', 'AllowAgentForwarding no', 'X11Forwarding no', 'PermitTunnel no', 'GatewayPorts no']) expect(s).toContain(d);
    expect(s.indexOf('-t -f')).toBeGreaterThan(-1);
    expect(s.indexOf('-t -f')).toBeLessThan(s.indexOf('Restart-Service sshd'));
    expect(s).toContain('.bosun-bak');
    expect(s.trim().split('\n').slice(-1)[0]).toContain('Restart-Service sshd');   // restart last: it drops the connection
  });

  it('replaces or appends the key as asked', () => {
    expect(s).toContain('$replace = $true');
    expect(windowsShellAccountScript({ ...opts, replaceKeys: false })).toContain('$replace = $false');
  });

  it('quotes values safely', () => {
    const evil = windowsShellAccountScript({ ...opts, publicKey: "ssh-ed25519 AAAA host'; Remove-Item C:\\ -Recurse #" });
    expect(evil).toContain("$key = 'ssh-ed25519 AAAA host''; Remove-Item C:\\ -Recurse #'");
  });

  it('is ASCII only (PowerShell 5.1 reads a script without a BOM as ANSI)', () => {
    expect(/^[\x00-\x7f]*$/.test(s)).toBe(true);
    expect(/^[\x00-\x7f]*$/.test(WINDOWS_SHELL_VERIFY_COMMAND)).toBe(true);
  });
});

describe('parseWindowsShellVerification', () => {
  const clean = 'WHOAMI DESKTOP-1\\bosun-user\nADMIN False\nGROUPS DESKTOP-1\\None;Everyone;BUILTIN\\Users;NT AUTHORITY\\NETWORK\nHIGH False\nWRITE_WINDIR NO\nREAD_ADMIN_KEYS NO\n';

  it('accepts a standard user', () => {
    expect(parseWindowsShellVerification(clean, 'bosun-user')).toEqual({ ok: true, problems: [] });
    expect(parseWindowsShellVerification(clean.replace(/\n/g, '\r\n'), 'BOSUN-USER').ok).toBe(true);
  });

  it('flags administrators, admin-like groups (even deny-only), elevation, and write or read access', () => {
    const bad = (from: string, to: string) => parseWindowsShellVerification(clean.replace(from, to), 'bosun-user');
    expect(bad('ADMIN False', 'ADMIN True').problems.join(' ')).toMatch(/administrator/);
    expect(bad('BUILTIN\\Users', 'BUILTIN\\Administrators').problems.join(' ')).toMatch(/Administrators group/);
    expect(bad('BUILTIN\\Users', 'BUILTIN\\Backup Operators').ok).toBe(false);
    expect(bad('BUILTIN\\Users', 'S-1-5-32-544').ok).toBe(false);
    expect(bad('HIGH False', 'HIGH True').problems.join(' ')).toMatch(/High integrity/);
    expect(bad('WRITE_WINDIR NO', 'WRITE_WINDIR YES').problems.join(' ')).toMatch(/Windows folder/);
    expect(bad('READ_ADMIN_KEYS NO', 'READ_ADMIN_KEYS YES').problems.join(' ')).toMatch(/authorized keys/);
    expect(bad('DESKTOP-1\\bosun-user', 'DESKTOP-1\\bosun-svc').problems.join(' ')).toMatch(/not "bosun-user"/);
  });

  it('treats missing output as a problem: unknown is never safe', () => {
    const r = parseWindowsShellVerification('', 'bosun-user');
    expect(r.ok).toBe(false);
    expect(r.problems.length).toBeGreaterThanOrEqual(5);
  });

  it('the verify command prints every marker the parser reads', () => {
    for (const m of ['WHOAMI', 'ADMIN', 'GROUPS', 'HIGH', 'WRITE_WINDIR', 'READ_ADMIN_KEYS']) expect(WINDOWS_SHELL_VERIFY_COMMAND).toContain(m);
  });
});
