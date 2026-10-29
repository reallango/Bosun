/**
 * The Custom Command widget: one saved command, run as the host's non-admin shell account and
 * repeated at a chosen interval. Pure helpers (the route does the running).
 */

export const MIN_INTERVAL_SEC = 10;
export const MAX_INTERVAL_SEC = 3600;
export const DEFAULT_INTERVAL_SEC = 30;
export const DEFAULT_COMMAND = 'uptime';
/** `uptime` does not exist in PowerShell, so the untouched default means this on Windows. */
export const WINDOWS_DEFAULT_COMMAND = "$o = Get-CimInstance Win32_OperatingSystem; 'Up since ' + $o.LastBootUpTime";

/** How often the command repeats, from the widget's settings, kept within the allowed range. */
export function intervalOf(cfg: { interval?: unknown } | null | undefined): number {
  const n = Math.round(Number(cfg?.interval));
  if (!Number.isFinite(n) || cfg?.interval === '' || cfg?.interval === null || cfg?.interval === undefined) return DEFAULT_INTERVAL_SEC;
  return Math.min(MAX_INTERVAL_SEC, Math.max(MIN_INTERVAL_SEC, n));
}

/** The command to run: the saved one, or the platform's default when it is empty or still the stock `uptime`. */
export function effectiveCommand(cfg: { command?: unknown } | null | undefined, platform: 'linux' | 'windows'): string {
  const saved = typeof cfg?.command === 'string' ? cfg.command.trim() : '';
  if (!saved || (saved === DEFAULT_COMMAND && platform === 'windows')) return platform === 'windows' ? WINDOWS_DEFAULT_COMMAND : DEFAULT_COMMAND;
  return saved;
}

/** Output shown in the widget: standard output, then anything printed to standard error. */
export function combinedOutput(stdout: string, stderr: string, limit = 64 * 1024): string {
  const parts = [stdout.trimEnd(), stderr.trim()].filter(Boolean);
  return parts.join('\n').slice(0, limit);
}
