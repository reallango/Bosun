import { SSHConnectionPool, SSHConnectionConfig, CommandResult } from './connection-pool';
import { powershellCommand } from '../windows/collectors';

/**
 * Platform branching helpers.
 *
 * Bosun talks to every host over SSH. Linux hosts run their command verbatim;
 * Windows hosts run the same logical operation as a PowerShell script through
 * the OpenSSH server. This module is the single place that decides which of the
 * two a given server needs.
 *
 * The PowerShell quoting itself lives in the shared `windows/collectors`
 * module (the poller, which cannot import TypeScript, needs it too), so there
 * is exactly one quoter.
 */

export interface PlatformServer {
  id: string;
  platform?: string | null;
}

export function isWindows(server: PlatformServer | null | undefined): boolean {
  return server?.platform === 'windows';
}

export { powershellCommand };

/**
 * Run a command on a server, translating it to PowerShell when the server is
 * Windows. This is the single branch point used by the widget/detect routes.
 */
export async function runOnServer(
  pool: SSHConnectionPool,
  server: PlatformServer,
  sshConfig: SSHConnectionConfig,
  command: string
): Promise<CommandResult> {
  const cmd = isWindows(server) ? powershellCommand(command) : command;
  return pool.executeCommand(server.id, sshConfig, cmd);
}
