/**
 * Running commands on a host as the administrator whose password the person typed (provisioning
 * and key cleanup). The password is used for this one call and never stored.
 */
import { Client } from 'ssh2';

export interface SshAuth {
  host: string;
  port: number;
  username: string;
  password: string;
}

/** Run a command over SSH with a password. */
export function sshExec(config: SshAuth, command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const timeout = setTimeout(() => {
      conn.end();
      reject(new Error('SSH connection timeout'));
    }, 15000);

    conn.on('ready', () => {
      conn.exec(command, (err, stream) => {
        if (err) {
          clearTimeout(timeout);
          conn.end();
          reject(err);
          return;
        }
        let stdout = '';
        let stderr = '';
        stream.on('close', (code: number) => {
          clearTimeout(timeout);
          conn.end();
          resolve({ stdout, stderr, exitCode: code });
        });
        stream.on('data', (data: Buffer) => { stdout += data.toString(); });
        stream.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
      });
    });

    conn.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    conn.connect({ host: config.host, port: config.port, username: config.username, password: config.password, readyTimeout: 10000 });
  });
}

export function stripSudo(stderr: string): string {
  return stderr.replace(/^\[sudo\]/gm, '').trim();
}

/** Single-quote a value for a POSIX shell. */
export const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Wrap a script so it runs as root on the host: directly when the admin user is
 * root, otherwise through sudo with the admin password. The script travels
 * base64-encoded so it can contain any quoting.
 */
export function asRootCommand(sshConfig: SshAuth, adminPassword: string, script: string): string {
  const run = `sh -c "$(printf %s '${Buffer.from(script).toString('base64')}' | base64 -d)"`;
  return sshConfig.username === 'root' ? run : `echo ${shq(adminPassword)} | sudo -S -p '' ${run}`;
}
