import { rqlite } from '../db/rqlite-client';
import { sshPool, SSHConnectionConfig } from '../ssh/connection-pool';
import { powershellCommand } from '../ssh/platform';
import { detectServerOs } from '../ssh/detect';
import { decrypt } from '../crypto/keys';

let healthCheckInterval: NodeJS.Timeout | null = null;

export async function startHealthChecker(): Promise<void> {
  if (healthCheckInterval) return;

  console.log('Starting health checker...');
  
  const checkServers = async () => {
    try {
      const result = await rqlite.query(`SELECT id, hostname, ssh_port, ssh_user, ssh_key_id, platform, os_type FROM servers`);
      
      for (const row of result.values) {
        const [id, hostname, sshPort, sshUser, sshKeyId, platform, osType] = row;
        if (!hostname || !sshUser || !sshKeyId) continue;

        try {
          // Get SSH key
          const keyResult = await rqlite.query(`SELECT private_key_enc FROM ssh_keys WHERE id = '${sshKeyId}'`);
          if (keyResult.values.length === 0) continue;

          const masterKey = process.env.MASTER_KEY;
          if (!masterKey) continue;

          const privateKeyEnc = keyResult.values[0][0] as string;
          const privateKey = decrypt(privateKeyEnc, masterKey);

          const sshConfig: SSHConnectionConfig = {
            host: hostname as string,
            port: sshPort as number,
            username: sshUser as string,
            privateKey
          };

          // Liveness probe. Windows OpenSSH may not run a shell by default for
          // non-interactive exec, so use a PowerShell command there.
          const probe = platform === 'windows' ? powershellCommand('Write-Output ok') : 'echo test';
          await sshPool.executeCommand(id as string, sshConfig, probe);

          // Update online status
          await rqlite.execute(
            `UPDATE servers SET is_online = 1, last_seen = CURRENT_TIMESTAMP WHERE id = ?`,
            [id]
          );

          // First successful contact on a server whose OS is still unknown:
          // detect and persist os_type/cpu/ram so the UI stops showing
          // "Unknown OS" without a manual Detect OS click. Runs at most once.
          if (!osType) {
            try {
              await detectServerOs(id as string, { platform: platform as string }, sshConfig);
            } catch (detectErr) {
              console.error(`OS detect failed for ${id}:`, detectErr);
            }
          }
        } catch {
          // Mark as offline
          await rqlite.execute(
            `UPDATE servers SET is_online = 0 WHERE id = ?`,
            [id]
          );
        }
      }
    } catch (err) {
      console.error('Health check error:', err);
    }
  };

  // Resolve the interval and schedule before the first check, so server startup
  // is never blocked waiting on SSH/rqlite.
  let intervalSec = 30;
  try {
    const configResult = await rqlite.query(`SELECT value FROM app_config WHERE key = 'health.check_interval_sec'`);
    intervalSec = parseInt(configResult.values[0]?.[0] as string || '30', 10);
  } catch (err) {
    console.error('Health checker: could not read interval, using 30s:', err);
  }

  // Schedule periodic checks
  healthCheckInterval = setInterval(checkServers, intervalSec * 1000);

  // Fire-and-forget the initial check so `register()` returns promptly.
  void checkServers();
}

export function stopHealthChecker(): void {
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
    healthCheckInterval = null;
  }
}