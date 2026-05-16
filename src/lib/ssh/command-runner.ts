import { SSHConnectionPool, SSHConnectionConfig, CommandResult } from './connection-pool';

export function createCommandRunner(
  pool: SSHConnectionPool,
  serverId: string,
  sshConfig: SSHConnectionConfig
): (command: string) => Promise<CommandResult> {
  return async (command: string): Promise<CommandResult> => {
    return pool.executeCommand(serverId, sshConfig, command);
  };
}