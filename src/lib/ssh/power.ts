export type PowerAction = 'shutdown' | 'restart';

export function isPowerAction(value: unknown): value is PowerAction {
  return value === 'shutdown' || value === 'restart';
}

/** Marker printed when the SSH user cannot run `sudo` without a password. */
export const NO_SUDO_MARKER = 'BOSUN_NOSUDO';

/**
 * The command that powers a host off or restarts it.
 *
 * The action is scheduled a couple of seconds out and detached, so the SSH
 * command returns normally before the connection drops (otherwise a
 * successful shutdown looks like a failed command). Linux uses non-interactive
 * sudo and fails fast, reporting NO_SUDO_MARKER, when it needs a password.
 * Windows has no sudo: the service account is an administrator.
 */
export function powerCommand(platform: 'linux' | 'windows', action: PowerAction): string {
  if (platform === 'windows') {
    return action === 'shutdown'
      ? 'shutdown.exe /s /t 3 /c "Bosun: shutdown requested"'
      : 'shutdown.exe /r /t 3 /c "Bosun: restart requested"';
  }
  const run = action === 'shutdown'
    ? 'systemctl poweroff || shutdown -h now || poweroff'
    : 'systemctl reboot || shutdown -r now || reboot';
  return `if ! sudo -n true 2>/dev/null; then echo ${NO_SUDO_MARKER}; exit 1; fi; `
    + `nohup sudo -n sh -c 'sleep 2; ${run}' >/dev/null 2>&1 & echo BOSUN_SCHEDULED`;
}
