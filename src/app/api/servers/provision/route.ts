// src/app/api/servers/provision/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireRole } from '@/lib/auth/middleware';
import { rqlite } from '@/lib/db/rqlite-client';
import { Client } from 'ssh2';
import { encrypt } from '@/lib/crypto/keys';
import { generateSSHKeyPair } from '@/lib/ssh/keygen';
import crypto from 'crypto';

// Helper to run a command over SSH
async function sshExec(
    config: { host: string; port: number; username: string; password: string },
    command: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
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

        conn.connect({
            host: config.host,
            port: config.port,
            username: config.username,
            password: config.password,
            readyTimeout: 10000,
        });
    });
}

export async function POST(request: NextRequest) {
    // Require admin role
    const auth = await requireAuth(request);
    if (auth instanceof NextResponse) return auth;
    const roleCheck = requireRole(auth as any, 'admin');
    if (roleCheck) return roleCheck;

    try {
        const {
            hostname,
            port = 22,
            admin_username,
            admin_password,
            service_account = 'bosun-svc',
        } = await request.json();

        if (!hostname || !admin_username || !admin_password) {
            return NextResponse.json({
                error: { message: 'hostname, admin_username, and admin_password required', code: 'VALIDATION_ERROR' },
            }, { status: 400 });
        }

        const steps: string[] = [];
        const sshConfig = { host: hostname, port, username: admin_username, password: admin_password };

        // Check if admin is root (doesn't need sudo)
        const isRoot = admin_username === 'root';
        // Escape password for shell
        const escapedPassword = admin_password.replace(/'/g, "'\\''");

        // Step 1: Test admin connection
        try {
            await sshExec(sshConfig, 'echo "connected"');
            steps.push('Admin SSH connection OK');
        } catch (err) {
            return NextResponse.json({
                error: { message: `Cannot connect: ${String(err)}`, code: 'SSH_CONNECT_FAILED' },
            }, { status: 400 });
        }

        // Step 2: Check/create service account
        const userCheck = await sshExec(sshConfig, `id ${service_account} 2>/dev/null && echo EXISTS || echo MISSING`);
        const accountExists = userCheck.stdout.trim().includes('EXISTS');

        if (!accountExists) {
            // Build command with or without sudo based on admin user
            const createCmd = isRoot
                ? `useradd -m -s /bin/bash ${service_account} && usermod -aG sudo ${service_account}`
                : `echo '${escapedPassword}' | sudo -S useradd -m -s /bin/bash ${service_account} && echo '${escapedPassword}' | sudo -S usermod -aG sudo ${service_account}`;
            const createResult = await sshExec(sshConfig, createCmd);
            // Handle "already exists" or other non-critical errors
            if (createResult.exitCode !== 0 && !createResult.stderr.includes('already exists')) {
                return NextResponse.json({
                    error: { message: `Failed to create account: ${createResult.stderr.replace(/^\[sudo\]/gm, '').trim()}`, code: 'ACCOUNT_CREATE_FAILED' },
                }, { status: 400 });
            }
            steps.push(`Created service account: ${service_account}`);
        } else {
            steps.push(`Service account exists: ${service_account}`);
        }

        // Step 2b: Add service account to docker group
        const dockerGroupCmd = isRoot
            ? `usermod -aG docker ${service_account} || groupadd docker || true`
            : `echo '${escapedPassword}' | sudo -S usermod -aG docker ${service_account} 2>/dev/null || echo '${escapedPassword}' | sudo -S groupadd docker 2>/dev/null || true`;
        const dockerResult = await sshExec(sshConfig, dockerGroupCmd);
        steps.push('Added service account to docker group');

        // Step 3: Generate SSH key pair using ssh-keygen
        const keyName = `${hostname}-${service_account}`;
        const { privateKey, publicKey, fingerprint } = generateSSHKeyPair(keyName, 'ed25519');
        const encryptedPrivateKey = encrypt(privateKey, process.env.MASTER_KEY || '');

        // Store key
        const keyId = crypto.randomUUID();
        const now = new Date().toISOString();
        await rqlite.execute(
            'INSERT INTO ssh_keys (id, name, fingerprint, public_key, private_key_enc, key_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [keyId, keyName, fingerprint, publicKey, encryptedPrivateKey, 'ed25519', now]
        );
        steps.push('Generated ED25519 SSH key');

        // Step 4: Install public key on server
        const installCmd = isRoot
            ? [
                `mkdir -p /home/${service_account}/.ssh`,
                `echo '${publicKey}' >> /home/${service_account}/.ssh/authorized_keys`,
                `chmod 700 /home/${service_account}/.ssh`,
                `chmod 600 /home/${service_account}/.ssh/authorized_keys`,
                `chown -R ${service_account}:${service_account} /home/${service_account}/.ssh`,
            ].join(' && ')
            : [
                `echo '${escapedPassword}' | sudo -S mkdir -p /home/${service_account}/.ssh 2>/dev/null`,
                `echo '${publicKey}' | sudo -S tee -a /home/${service_account}/.ssh/authorized_keys > /dev/null 2>/dev/null`,
                `echo '${escapedPassword}' | sudo -S chmod 700 /home/${service_account}/.ssh 2>/dev/null`,
                `echo '${escapedPassword}' | sudo -S chmod 600 /home/${service_account}/.ssh/authorized_keys 2>/dev/null`,
                `echo '${escapedPassword}' | sudo -S chown -R ${service_account}:${service_account} /home/${service_account}/.ssh 2>/dev/null`,
            ].join(' && ');

        const installResult = await sshExec(sshConfig, installCmd);
        if (installResult.exitCode !== 0) {
            return NextResponse.json({
                error: { message: `Failed to install key: ${installResult.stderr.replace(/^\[sudo\]/gm, '').trim()}`, code: 'KEY_INSTALL_FAILED' },
            }, { status: 400 });
        }
        steps.push('Public key installed');

        // Step 5: Test connection with new key
        let testSuccess = false;
        try {
            const testConn = new Client();
            await new Promise<void>((resolve, reject) => {
                const timeout = setTimeout(() => { testConn.end(); reject(new Error('Test timeout')); }, 10000);
                testConn.on('ready', () => { clearTimeout(timeout); testConn.end(); resolve(); });
                testConn.on('error', (err) => { clearTimeout(timeout); reject(err); });
                testConn.connect({ host: hostname, port, username: service_account, privateKey, readyTimeout: 10000 });
            });
            testSuccess = true;
            steps.push('Key-based connection OK');
        } catch (err) {
            steps.push(`Key test failed: ${String(err)}`);
        }

        // Log to audit
        await rqlite.execute(
            'INSERT INTO audit_log (id, user_id, action, category, details, created_at) VALUES (?, ?, ?, ?, ?, ?)',
            [crypto.randomUUID(), (auth as any).userId, 'server.provision', 'server', JSON.stringify({ steps, service_account }), now]
        );

        return NextResponse.json({
            data: {
                ssh_key_id: keyId,
                ssh_key_name: keyName,
                service_account,
                public_key: publicKey,
                test_success: testSuccess,
                steps,
            },
        });
    } catch (error) {
        console.error('Provision error:', error);
        return NextResponse.json({
            error: { message: String(error), code: 'PROVISION_ERROR' },
        }, { status: 500 });
    }
}