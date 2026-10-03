/**
 * Wake-on-LAN via a managed "local server".
 *
 * A magic packet only reaches a powered-off host when it is sent from the same
 * L2 segment. The Bosun container is usually NAT'd away from the target, but a
 * managed server (typically the Docker host) sits on the right subnet, so Bosun
 * runs the `wakeonlan` utility there over SSH instead of emitting the packet
 * itself.
 *
 * The utility is optional: callers run the wake command first and only fall
 * back to probing for an installed binary when it fails, so the common path
 * costs a single SSH command.
 */
import { CommandResult } from '@/lib/ssh/connection-pool';

export type WolRun = (command: string) => Promise<CommandResult>;
export type WolRunPS = (script: string) => Promise<CommandResult>;

const WOL_BIN = 'wakeonlan';

export interface WolInstallPlan {
  /** Whether Bosun can install the utility itself on this platform. */
  supported: boolean;
  /** Command to run (via sudo -n) to install the utility; null when unsupported. */
  command: string | null;
  /** Human note when installation is not automatable. */
  note?: string;
}

export interface HostWakeOutcome {
  ok: boolean;
  /** The utility is missing on the host; the caller should offer to install it. */
  needsInstall: boolean;
  broadcast: string;
  port: number;
  stdout: string;
  stderr: string;
  error?: string;
}

function wakeArgs(mac: string, broadcast: string, port: number): string {
  // wakeonlan sends to the default port 9 unless -p overrides it.
  return port === 9 ? `-i ${broadcast} ${mac}` : `-i ${broadcast} -p ${port} ${mac}`;
}

function failureDetail(result: CommandResult): string {
  return (result.stderr || result.stdout).trim() || `wakeonlan exited with code ${result.exitCode}`;
}

/** Is the `wakeonlan` utility present on a Linux host? */
export async function isWolInstalledLinux(run: WolRun): Promise<boolean> {
  const r = await run(`command -v ${WOL_BIN} >/dev/null 2>&1 && echo INSTALLED || echo MISSING`);
  return r.stdout.includes('INSTALLED');
}

/** Is the `wakeonlan` utility present on a Windows host (on PATH)? */
export async function isWolInstalledWindows(runPS: WolRunPS): Promise<boolean> {
  const r = await runPS(
    `if (Get-Command ${WOL_BIN} -ErrorAction SilentlyContinue) { 'INSTALLED' } else { 'MISSING' }`
  );
  return r.stdout.includes('INSTALLED');
}

/** How to install the utility on a Linux host, by package manager. */
export function wolInstallPlanLinux(osType: string | null): WolInstallPlan {
  const t = (osType || '').toLowerCase();
  if (t.includes('unraid') || t.includes('slackware')) {
    // Unraid has no apt/dnf; slackpkg can pull the Slackware package.
    return {
      supported: true,
      command: `/sbin/slackpkg -batch=on -default_answer=y install wakeonlan`,
    };
  }
  if (t.includes('rhel') || t.includes('centos') || t.includes('fedora') || t.includes('rocky') || t.includes('alma')) {
    return { supported: true, command: `dnf install -y wakeonlan` };
  }
  return { supported: true, command: `apt-get install -y wakeonlan` };
}

export function wolInstallPlanWindows(): WolInstallPlan {
  return {
    supported: false,
    command: null,
    note: 'Install a wakeonlan CLI on the Windows host and ensure it is on PATH, then retry.',
  };
}

/**
 * Run the wake command on a Linux host. On failure, probe for the binary so the
 * caller can distinguish "not installed" from "installed but the send failed".
 */
export async function wakeViaLinuxHost(
  run: WolRun,
  mac: string,
  broadcast: string,
  port: number
): Promise<HostWakeOutcome> {
  const result = await run(`${WOL_BIN} ${wakeArgs(mac, broadcast, port)}`);
  if (result.exitCode === 0) {
    return { ok: true, needsInstall: false, broadcast, port, stdout: result.stdout, stderr: result.stderr };
  }
  const installed = await isWolInstalledLinux(run);
  return {
    ok: false,
    needsInstall: !installed,
    broadcast,
    port,
    stdout: result.stdout,
    stderr: result.stderr,
    error: failureDetail(result),
  };
}

/** Run the wake command on a Windows host (same probe-on-failure contract). */
export async function wakeViaWindowsHost(
  runPS: WolRunPS,
  mac: string,
  broadcast: string,
  port: number
): Promise<HostWakeOutcome> {
  const result = await runPS(`${WOL_BIN} ${wakeArgs(mac, broadcast, port)}`);
  if (result.exitCode === 0) {
    return { ok: true, needsInstall: false, broadcast, port, stdout: result.stdout, stderr: result.stderr };
  }
  const installed = await isWolInstalledWindows(runPS);
  return {
    ok: false,
    needsInstall: !installed,
    broadcast,
    port,
    stdout: result.stdout,
    stderr: result.stderr,
    error: failureDetail(result),
  };
}

