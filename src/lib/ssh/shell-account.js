'use strict';

/**
 * The non-admin ("shell") account every Linux host can have next to its privileged
 * service account. API terminals and API shell commands log in as THIS account, with
 * its own key, so a caller that was only meant to look around has no sudo, no Docker
 * group and no key to the admin account.
 *
 * Plain CommonJS with no imports: shared by the Next.js routes, ws-server.js and the tests.
 */

/** Groups that amount to administrator rights (or reading secrets / raw disks) on Linux. */
const ADMIN_LIKE_GROUPS = ['sudo', 'wheel', 'admin', 'docker', 'lxd', 'lxc', 'libvirt', 'disk', 'root', 'shadow'];

const SHELL_ACCOUNT_RE = /^[a-z_][a-z0-9_-]{0,19}$/;
const DEFAULT_SHELL_ACCOUNT = 'bosun-user';

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * Script (run as root) that creates or repairs the shell account:
 *  - no sudo/wheel/docker/... membership, even if the account already existed with some;
 *  - password locked (only the key works);
 *  - its key installed (replacing earlier keys, or added next to them);
 *  - the admin account's home closed to everyone else;
 *  - sshd told never to forward ports, agents, X11 or tunnels for this account.
 * Prints BOSUN_SHELL_OK at the end, and one of BOSUN_SSHD_RESTRICTED / _UNCHANGED / _NOINCLUDE.
 * Exit codes 11-14 identify the step that failed.
 *
 * @param {{ account: string, privilegedAccount: string, publicKey: string, replaceKeys: boolean }} opts
 * @returns {string}
 */
function shellAccountScript(opts) {
  const groups = ADMIN_LIKE_GROUPS.join(' ');
  return [
    `U=${shq(opts.account)}; P=${shq(opts.privilegedAccount)}; KEY=${shq(opts.publicKey)}`,
    `sh_path=/bin/sh; [ -x /bin/bash ] && sh_path=/bin/bash`,
    `if ! id "$U" >/dev/null 2>&1; then useradd -m -s "$sh_path" "$U" || exit 11; fi`,
    `for g in ${groups}; do if getent group "$g" >/dev/null 2>&1; then gpasswd -d "$U" "$g" >/dev/null 2>&1; fi; done`,
    `passwd -l "$U" >/dev/null 2>&1 || usermod -L "$U" || exit 12`,
    `home=$(getent passwd "$U" | cut -d: -f6); [ -n "$home" ] || exit 13`,
    `d="$home/.ssh"; ak="$d/authorized_keys"; mkdir -p "$d" || exit 14`,
    opts.replaceKeys
      ? `printf '%s\\n' "$KEY" > "$ak"`
      : `touch "$ak"; grep -qxF -- "$KEY" "$ak" || printf '%s\\n' "$KEY" >> "$ak"`,
    `chmod 700 "$d"; chmod 600 "$ak"; chown -R "$U":"$(id -gn "$U")" "$d"`,
    `ph=$(getent passwd "$P" | cut -d: -f6); [ -n "$ph" ] && chmod go-rwx "$ph" 2>/dev/null`,
    `if grep -qiE '^[[:space:]]*Include[[:space:]].*sshd_config\\.d' /etc/ssh/sshd_config 2>/dev/null; then`,
    `  mkdir -p /etc/ssh/sshd_config.d; f="/etc/ssh/sshd_config.d/60-bosun-shell-$U.conf"`,
    `  printf 'Match User %s\\n    AllowTcpForwarding no\\n    AllowAgentForwarding no\\n    AllowStreamLocalForwarding no\\n    X11Forwarding no\\n    PermitTunnel no\\n    GatewayPorts no\\n' "$U" > "$f"; chmod 644 "$f"`,
    `  s=$(command -v sshd || echo /usr/sbin/sshd)`,
    `  if "$s" -t >/dev/null 2>&1; then`,
    `    (systemctl reload ssh >/dev/null 2>&1 || systemctl reload sshd >/dev/null 2>&1 || kill -HUP "$(cat /run/sshd.pid 2>/dev/null)") >/dev/null 2>&1; echo BOSUN_SSHD_RESTRICTED`,
    `  else rm -f "$f"; echo BOSUN_SSHD_UNCHANGED; fi`,
    `else echo BOSUN_SSHD_NOINCLUDE; fi`,
    `echo BOSUN_SHELL_OK`,
  ].join('\n');
}

/** Command run as the shell account (with its own key) to prove it has no admin rights. */
const SHELL_VERIFY_COMMAND =
  'echo "WHOAMI $(whoami)"; echo "UID $(id -u)"; echo "GROUPS $(id -nG 2>/dev/null)"; '
  + 'if sudo -n true >/dev/null 2>&1; then echo SUDO_OK; else echo SUDO_NO; fi; '
  + 'if [ -r /var/run/docker.sock ] || [ -w /var/run/docker.sock ]; then echo DOCKER_SOCKET_OK; else echo DOCKER_SOCKET_NO; fi';

/**
 * Interpret SHELL_VERIFY_COMMAND's output. Anything unexpected is a problem: unknown is not safe.
 * @param {string} stdout
 * @param {string} expectedAccount
 * @returns {{ ok: boolean, problems: string[] }}
 */
function parseShellVerification(stdout, expectedAccount) {
  const line = (k) => {
    const m = String(stdout).match(new RegExp(`^${k} ?(.*)$`, 'm'));
    return m ? m[1].trim() : undefined;
  };
  const problems = [];
  const who = line('WHOAMI');
  if (who !== expectedAccount) problems.push(`it logged in as "${who ?? '?'}", not "${expectedAccount}"`);
  const uid = line('UID');
  if (uid === undefined || uid === '' || uid === '0') problems.push(uid === '0' ? 'it is root (uid 0)' : 'its user id could not be read');
  const groups = (line('GROUPS') ?? '').split(/\s+/).filter(Boolean);
  const bad = groups.filter(g => ADMIN_LIKE_GROUPS.includes(g));
  if (bad.length) problems.push(`it is in the ${bad.join(', ')} group${bad.length === 1 ? '' : 's'}`);
  if (/^SUDO_OK$/m.test(stdout)) problems.push('it can use sudo without a password');
  else if (!/^SUDO_NO$/m.test(stdout)) problems.push('sudo could not be checked');
  if (/^DOCKER_SOCKET_OK$/m.test(stdout)) problems.push('it can reach the Docker socket');
  else if (!/^DOCKER_SOCKET_NO$/m.test(stdout)) problems.push('Docker socket access could not be checked');
  return { ok: problems.length === 0, problems };
}

module.exports = { ADMIN_LIKE_GROUPS, SHELL_ACCOUNT_RE, DEFAULT_SHELL_ACCOUNT, shellAccountScript, SHELL_VERIFY_COMMAND, parseShellVerification };
