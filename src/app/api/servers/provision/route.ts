// src/app/api/servers/provision/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireRole } from '@/lib/auth/middleware';
import { rqlite } from '@/lib/db/rqlite-client';
import { Client } from 'ssh2';
import { encrypt } from '@/lib/crypto/keys';
import { generateSSHKeyPair } from '@/lib/ssh/keygen';
import { powershellCommand } from '@/lib/windows/collectors';
import crypto from 'crypto';

interface SshAuth {
    host: string;
    port: number;
    username: string;
    password: string;
}

// SAM account names on Windows are capped at 20 characters; the same bound is
// safe everywhere and keeps the name from breaking the shell commands below.
const SERVICE_ACCOUNT_RE = /^[A-Za-z_][A-Za-z0-9._-]{0,19}$/;

// Helper to run a command over SSH
async function sshExec(
    config: SshAuth,
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

interface SetupResult {
    steps?: string[];
    error?: { message: string; code: string };
}

function stripSudo(stderr: string): string {
    return stderr.replace(/^\[sudo\]/gm, '').trim();
}

/** Quote a value for embedding inside a PowerShell single-quoted string. */
function psQuote(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Create/verify the service account on a Linux host, grant it sudo + docker,
 * and install the Bosun public key.
 */
async function setupLinux(
    sshConfig: SshAuth,
    serviceAccount: string,
    adminPassword: string,
    publicKey: string
): Promise<SetupResult> {
    const steps: string[] = [];
    const isRoot = sshConfig.username === 'root';
    const escapedPassword = adminPassword.replace(/'/g, "'\\''");

    const userCheck = await sshExec(sshConfig, `id ${serviceAccount} 2>/dev/null && echo EXISTS || echo MISSING`);
    if (!userCheck.stdout.includes('EXISTS')) {
        const createCmd = isRoot
            ? `useradd -m -s /bin/bash ${serviceAccount} && usermod -aG sudo ${serviceAccount}`
            : `echo '${escapedPassword}' | sudo -S useradd -m -s /bin/bash ${serviceAccount} && echo '${escapedPassword}' | sudo -S usermod -aG sudo ${serviceAccount}`;
        const createResult = await sshExec(sshConfig, createCmd);
        if (createResult.exitCode !== 0 && !createResult.stderr.includes('already exists')) {
            return { error: { message: `Failed to create account: ${stripSudo(createResult.stderr)}`, code: 'ACCOUNT_CREATE_FAILED' } };
        }
        steps.push(`Created service account: ${serviceAccount}`);
    } else {
        steps.push(`Service account exists: ${serviceAccount}`);
    }

    const dockerGroupCmd = isRoot
        ? `usermod -aG docker ${serviceAccount} || groupadd docker || true`
        : `echo '${escapedPassword}' | sudo -S usermod -aG docker ${serviceAccount} 2>/dev/null || echo '${escapedPassword}' | sudo -S groupadd docker 2>/dev/null || true`;
    await sshExec(sshConfig, dockerGroupCmd);
    steps.push('Added service account to docker group');

    const installCmd = isRoot
        ? [
            `mkdir -p /home/${serviceAccount}/.ssh`,
            `echo '${publicKey}' >> /home/${serviceAccount}/.ssh/authorized_keys`,
            `chmod 700 /home/${serviceAccount}/.ssh`,
            `chmod 600 /home/${serviceAccount}/.ssh/authorized_keys`,
            `chown -R ${serviceAccount}:${serviceAccount} /home/${serviceAccount}/.ssh`,
        ].join(' && ')
        : [
            `echo '${escapedPassword}' | sudo -S mkdir -p /home/${serviceAccount}/.ssh 2>/dev/null`,
            `echo '${publicKey}' | sudo -S tee -a /home/${serviceAccount}/.ssh/authorized_keys > /dev/null 2>/dev/null`,
            `echo '${escapedPassword}' | sudo -S chmod 700 /home/${serviceAccount}/.ssh 2>/dev/null`,
            `echo '${escapedPassword}' | sudo -S chmod 600 /home/${serviceAccount}/.ssh/authorized_keys 2>/dev/null`,
            `echo '${escapedPassword}' | sudo -S chown -R ${serviceAccount}:${serviceAccount} /home/${serviceAccount}/.ssh 2>/dev/null`,
        ].join(' && ');

    const installResult = await sshExec(sshConfig, installCmd);
    if (installResult.exitCode !== 0) {
        return { error: { message: `Failed to install key: ${stripSudo(installResult.stderr)}`, code: 'KEY_INSTALL_FAILED' } };
    }
    steps.push('Public key installed');

    return { steps };
}

/**
 * Create/verify the service account on a Windows host over OpenSSH, add it to
 * the local Administrators group, hide it from the login screen, and install
 * the Bosun public key in the administrators' authorized keys file.
 *
 * The whole operation is a single PowerShell script; chaining native commands
 * with `&&` (as the Linux path does) is invalid in PowerShell.
 */
async function setupWindows(
    sshConfig: SshAuth,
    serviceAccount: string,
    adminPassword: string,
    publicKey: string
): Promise<SetupResult> {
    const steps: string[] = [];
    const acct = psQuote(serviceAccount);

    const accountScript = `
$ErrorActionPreference = 'Stop'
$acct = ${acct}
$user = Get-LocalUser -Name $acct -ErrorAction SilentlyContinue
if (-not $user) {
  $sec = ConvertTo-SecureString ${psQuote(adminPassword)} -AsPlainText -Force
  New-LocalUser -Name $acct -Password $sec -PasswordNeverExpires -AccountNeverExpires -Description 'Bosun service account' | Out-Null
  Write-Output 'CREATED'
} else {
  Write-Output 'EXISTS'
}
$admins = Get-LocalGroup -SID 'S-1-5-32-544'
$isMember = Get-LocalGroupMember -Group $admins | Where-Object { $_.Name -eq $acct -or $_.Name -like ('*\\' + $acct) }
if (-not $isMember) { Add-LocalGroupMember -Group $admins -Member $acct }
# Hide the account from the local login screen (Winlogon SpecialAccounts)
$winlogon = 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon\\SpecialAccounts\\UserList'
New-Item -Path $winlogon -Force | Out-Null
New-ItemProperty -Path $winlogon -Name $acct -Value 0 -PropertyType DWord -Force | Out-Null
Write-Output 'READY'
`.trim();

    const accountResult = await sshExec(sshConfig, powershellCommand(accountScript));
    if (accountResult.exitCode !== 0 || !accountResult.stdout.includes('READY')) {
        return { error: { message: `Failed to create account: ${accountResult.stderr.trim() || accountResult.stdout.trim()}`, code: 'ACCOUNT_CREATE_FAILED' } };
    }
    steps.push(accountResult.stdout.includes('CREATED')
        ? `Created service account: ${serviceAccount}`
        : `Service account exists: ${serviceAccount}`);
    steps.push('Added service account to Administrators and hid it from the login screen');

    const keyScript = `
$ErrorActionPreference = 'Stop'
$dir = Join-Path $env:ProgramData 'ssh'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$ak = Join-Path $dir 'administrators_authorized_keys'
$key = ${psQuote(publicKey)}
$existing = if (Test-Path $ak) { Get-Content $ak -Raw } else { '' }
if (-not $existing.Contains($key)) { Add-Content -Path $ak -Value $key }
# sshd requires this file to be owned by and readable only by SYSTEM/Administrators
$acl = Get-Acl $ak
$acl.SetAccessRuleProtection($true, $false)
foreach ($rule in @($acl.Access)) { $acl.RemoveAccessRule($rule) | Out-Null }
$adminsSid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')
$systemSid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')
$acl.SetOwner($adminsSid)
$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($adminsSid, 'FullControl', 'Allow')))
$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($systemSid, 'FullControl', 'Allow')))
Set-Acl -Path $ak -AclObject $acl
Write-Output 'OK'
`.trim();

    const keyResult = await sshExec(sshConfig, powershellCommand(keyScript));
    if (keyResult.exitCode !== 0 || !keyResult.stdout.includes('OK')) {
        return { error: { message: `Failed to install key: ${keyResult.stderr.trim() || keyResult.stdout.trim()}`, code: 'KEY_INSTALL_FAILED' } };
    }
    steps.push('Public key installed');

    // The terminal's "log in as yourself" flow uses a nested `ssh -t <user>@localhost`
    // (runas cannot attach a console over an SSH PTY). That needs sshd to accept
    // password auth, so ensure PasswordAuthentication yes and reload sshd.
    // Idempotent. Done last: Restart-Service sshd briefly drops this connection.
    const passwordAuthScript = `
$cfg = Join-Path $env:ProgramData 'ssh\\sshd_config'
$lines = if (Test-Path $cfg) { Get-Content $cfg } else { @() }
$found = $false
$out = foreach ($l in $lines) {
  if ($l -match '^\\s*#?\\s*PasswordAuthentication\\s') { $found = $true; 'PasswordAuthentication yes' }
  else { $l }
}
if (-not $found) { $out += 'PasswordAuthentication yes' }
Set-Content -Path $cfg -Value $out
Write-Output 'OK'
Restart-Service sshd -ErrorAction SilentlyContinue
`.trim();
    const passwordAuthResult = await sshExec(sshConfig, powershellCommand(passwordAuthScript));
    if (passwordAuthResult.stdout.includes('OK')) {
        steps.push('Enabled password authentication for sshd');
    } else {
        steps.push(`sshd password authentication not enabled: ${passwordAuthResult.stderr.trim() || 'config unavailable'}`);
    }

    return { steps };
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
            platform = 'linux',
            service_account = 'bosun-svc',
        } = await request.json();

        if (!hostname || !admin_username || !admin_password) {
            return NextResponse.json({
                error: { message: 'hostname, admin_username, and admin_password required', code: 'VALIDATION_ERROR' },
            }, { status: 400 });
        }

        if (!SERVICE_ACCOUNT_RE.test(service_account)) {
            return NextResponse.json({
                error: { message: 'service_account must be 1-20 characters (letters, digits, dot, dash, underscore)', code: 'VALIDATION_ERROR' },
            }, { status: 400 });
        }

        const isWindowsHost = platform === 'windows';
        const sshConfig: SshAuth = { host: hostname, port, username: admin_username, password: admin_password };

        // Step 1: Test admin connection
        try {
            await sshExec(sshConfig, isWindowsHost ? powershellCommand('Write-Output connected') : 'echo "connected"');
        } catch (err) {
            return NextResponse.json({
                error: { message: `Cannot connect: ${String(err)}`, code: 'SSH_CONNECT_FAILED' },
            }, { status: 400 });
        }

        // Step 2: Generate and store the SSH key pair
        const keyName = `${hostname}-${service_account}`;
        const { privateKey, publicKey, fingerprint } = generateSSHKeyPair(keyName, 'ed25519');
        const encryptedPrivateKey = encrypt(privateKey, process.env.MASTER_KEY || '');

        const keyId = crypto.randomUUID();
        const now = new Date().toISOString();
        await rqlite.execute(
            'INSERT INTO ssh_keys (id, name, fingerprint, public_key, private_key_enc, key_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [keyId, keyName, fingerprint, publicKey, encryptedPrivateKey, 'ed25519', now]
        );

        // Step 3: Create the service account and install the key on the host
        const setup = isWindowsHost
            ? await setupWindows(sshConfig, service_account, admin_password, publicKey)
            : await setupLinux(sshConfig, service_account, admin_password, publicKey);
        if (setup.error) {
            return NextResponse.json({ error: setup.error }, { status: 400 });
        }
        const steps: string[] = ['Admin SSH connection OK', 'Generated ED25519 SSH key', ...(setup.steps || [])];

        // Step 4: Test connection with the new key
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
            [crypto.randomUUID(), (auth as any).userId, 'server.provision', 'server', JSON.stringify({ steps, service_account, platform: isWindowsHost ? 'windows' : 'linux' }), now]
        );

        return NextResponse.json({
            data: {
                ssh_key_id: keyId,
                ssh_key_name: keyName,
                service_account,
                platform: isWindowsHost ? 'windows' : 'linux',
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
