import { rqlite } from '../db/rqlite-client';
import { sshPool, SSHConnectionConfig } from '../ssh/connection-pool';
import { decrypt } from '../crypto/keys';

let healthCheckInterval: NodeJS.Timeout | null = null;

export async function startHealthChecker(): Promise<void> {
  if (healthCheckInterval) return;

  console.log('Starting health checker...');
  
  const checkServers = async () => {
    try {
      const result = await rqlite.query(`SELECT id, hostname, ssh_port, ssh_user, ssh_key_id FROM servers`);
      
      for (const row of result.values) {
        const [id, hostname, sshPort, sshUser, sshKeyId] = row;
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

          // Try a simple command
          await sshPool.executeCommand(id as string, sshConfig, 'echo test');

          // Update online status
          await rqlite.execute(
            `UPDATE servers SET is_online = 1, last_seen = CURRENT_TIMESTAMP WHERE id = ?`,
            [id]
          );
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

  // Initial check
  await checkServers();

  // Get check interval from config
  const configResult = await rqlite.query(`SELECT value FROM app_config WHERE key = 'health.check_interval_sec'`);
  const intervalSec = parseInt(configResult.values[0]?.[0] as string || '30', 10);

  // Schedule periodic checks
  healthCheckInterval = setInterval(checkServers, intervalSec * 1000);
}

export function stopHealthChecker(): void {
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
    healthCheckInterval = null;
  }
}