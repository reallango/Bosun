import { execSync } from 'child_process';
import fs from 'fs';
import crypto from 'crypto';

export function generateSSHKeyPair(
    comment: string = 'bosun-generated',
    type: string = 'ed25519'
): { privateKey: string; publicKey: string; fingerprint: string } {
    const tmpDir = `/tmp/bosun-keygen-${crypto.randomUUID()}`;
    try {
        execSync(`mkdir -p ${tmpDir}`);

        // Generate key using ssh-keygen (produces OpenSSH format)
        execSync(
            `ssh-keygen -t ${type} -f ${tmpDir}/key -N "" -q -C "${comment}"`,
            { timeout: 10000 }
        );

        // Read the generated keys
        const privateKey = fs.readFileSync(`${tmpDir}/key`, 'utf-8');
        const publicKey = fs.readFileSync(`${tmpDir}/key.pub`, 'utf-8').trim();

        // Get fingerprint from ssh-keygen
        const fpOutput = execSync(`ssh-keygen -lf ${tmpDir}/key.pub`)
            .toString()
            .trim();
        // Output format: "256 SHA256:xxxx comment (ED25519)"
        const fingerprint = fpOutput.split(' ')[1] || '';

        return { privateKey, publicKey, fingerprint };
    } finally {
        // Always clean up temp files containing private key material
        try {
            execSync(`rm -rf ${tmpDir}`);
        } catch {
            // ignore cleanup errors
        }
    }
}