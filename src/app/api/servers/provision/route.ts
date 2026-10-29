// src/app/api/servers/provision/route.ts
import { getMasterKey } from '@/lib/secrets';
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireRole } from '@/lib/auth/middleware';
import { rqlite } from '@/lib/db/rqlite-client';
import { Client } from 'ssh2';
import { encrypt } from '@/lib/crypto/keys';
import { generateSSHKeyPair } from '@/lib/ssh/keygen';
import { powershellCommand } from '@/lib/collect/windows';
import { pruneWindowsKeysScript } from '@/lib/ssh/windows-keys';
import { linuxPruneScript, parseCandidates, type KeyCandidate } from '@/lib/ssh/key-cleanup';
import { windowsShellAccountScript, WINDOWS_SHELL_VERIFY_COMMAND, parseWindowsShellVerification } from '@/lib/ssh/windows-shell-account';
import {
    DEFAULT_SHELL_ACCOUNT, SHELL_ACCOUNT_RE, SHELL_VERIFY_COMMAND, parseShellVerification, shellAccountScript,
} from '@/lib/ssh/shell-account';
import { sshExec, stripSudo, shq, asRootCommand, type SshAuth } from '@/lib/ssh/admin-exec';
import crypto from 'crypto';

// SAM account names on Windows are capped at 20 characters; the same bound is
// safe everywhere and keeps the name from breaking the shell commands below.
const SERVICE_ACCOUNT_RE = /^[A-Za-z_][A-Za-z0-9._-]{0,19}$/;

/** Setup steps that start with this are shown as warnings, not successes. */
const WARNING = 'Warning: ';

interface SetupResult {
    steps?: string[];
    error?: { message: string; code: string };
}


/** Quote a value for embedding inside a PowerShell single-quoted string. */
function psQuote(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Shell script (run as root) that installs a validated sudoers drop-in giving
 * the service account passwordless sudo. Bosun runs its privileged actions
 * (OS updates, restart/shut down, installing wakeonlan, docker fallback) with
 * `sudo -n`, which fails rather than prompting. The rule is checked with
 * visudo before it is installed, so a bad rule can never break sudo. Only
 * characters allowed by SERVICE_ACCOUNT_RE reach the script.
 */
function sudoersScript(serviceAccount: string): string {
    const file = `bosun-${serviceAccount.replace(/[^A-Za-z0-9_-]/g, '_')}`;
    return `f=$(mktemp) && echo "${serviceAccount} ALL=(ALL) NOPASSWD:ALL" > "$f" && `
        + `visudo -cf "$f" >/dev/null && install -m 440 -o root -g root "$f" /etc/sudoers.d/${file}; rc=$?; rm -f "$f"; exit $rc`;
}

/** Add the Bosun public key to the service account's authorized_keys (idempotent). */
function installKeyScript(serviceAccount: string, publicKey: string): string {
    return `d=/home/${serviceAccount}/.ssh; ak="$d/authorized_keys"; KEY=${shq(publicKey)}; `
        + `mkdir -p "$d" && touch "$ak" && { grep -qxF -- "$KEY" "$ak" || echo "$KEY" >> "$ak"; } `
        + `&& chmod 700 "$d" && chmod 600 "$ak" && chown -R ${serviceAccount}:${serviceAccount} "$d"`;
}


/** Add the service account to the docker group; exit 3 when Docker is not installed (no such group). */
function dockerGroupScript(serviceAccount: string): string {
    return `getent group docker >/dev/null 2>&1 || exit 3; usermod -aG docker ${serviceAccount}`;
}

/**
 * Create/verify the service account on a Linux host, grant it passwordless sudo
 * + docker, and install the Bosun public key.
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
    const asRoot = (script: string) => asRootCommand(sshConfig, adminPassword, script);

    // The admin group is `sudo` on Debian/Ubuntu and `wheel` on RHEL-family hosts.
    // If neither exists the sudoers rule below still grants access.
    const groupCheck = await sshExec(sshConfig, 'getent group sudo >/dev/null 2>&1 && echo sudo || { getent group wheel >/dev/null 2>&1 && echo wheel; }');
    const adminGroup = /^(sudo|wheel)$/.test(groupCheck.stdout.trim()) ? groupCheck.stdout.trim() : '';
    const groupFlag = adminGroup ? `-G ${adminGroup} ` : '';

    const userCheck = await sshExec(sshConfig, `id ${serviceAccount} 2>/dev/null && echo EXISTS || echo MISSING`);
    if (!userCheck.stdout.includes('EXISTS')) {
        const createCmd = isRoot
            ? `useradd -m -s /bin/bash ${groupFlag}${serviceAccount}`
            : `echo '${escapedPassword}' | sudo -S useradd -m -s /bin/bash ${groupFlag}${serviceAccount}`;
        const createResult = await sshExec(sshConfig, createCmd);
        if (createResult.exitCode !== 0 && !createResult.stderr.includes('already exists')) {
            return { error: { message: `Failed to create account: ${stripSudo(createResult.stderr)}`, code: 'ACCOUNT_CREATE_FAILED' } };
        }
        steps.push(`Created service account: ${serviceAccount}`);
    } else {
        steps.push(`Service account exists: ${serviceAccount}`);
    }

    // Only join the docker group if Docker is installed (the group exists). Without
    // it this is a warning, not an error: run Provision again once Docker is installed.
    const dockerResult = await sshExec(sshConfig, asRoot(dockerGroupScript(serviceAccount)));
    if (dockerResult.exitCode === 0) {
        steps.push('Added service account to docker group');
    } else if (dockerResult.exitCode === 3) {
        steps.push(`${WARNING}Docker is not set up on this host (no docker group), so the service account was not added to it. Docker widgets will not work until Docker is installed; run Provision again afterwards.`);
    } else {
        steps.push(`${WARNING}Could not add the service account to the docker group (${stripSudo(dockerResult.stderr) || `exit ${dockerResult.exitCode}`}). Docker widgets may not work.`);
    }

    // Not fatal: an unusual host (no visudo, no /etc/sudoers.d) can still be used,
    // but actions that need root will ask for sudo to be configured by hand.
    const sudoersResult = await sshExec(sshConfig, asRoot(sudoersScript(serviceAccount)));
    steps.push(sudoersResult.exitCode === 0
        ? 'Enabled passwordless sudo for the service account'
        : `${WARNING}Could not enable passwordless sudo (${stripSudo(sudoersResult.stderr) || `exit ${sudoersResult.exitCode}`}); restart, shut down and OS updates need it`);

    const installResult = await sshExec(sshConfig, asRoot(installKeyScript(serviceAccount, publicKey)));
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

/** Run one command over SSH with a private key (used to log in as the shell account and check it). */
function sshExecWithKey(
    target: { host: string; port: number; username: string; privateKey: string },
    command: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
        const conn = new Client();
        const timeout = setTimeout(() => { conn.end(); reject(new Error('SSH connection timeout')); }, 15000);
        conn.on('ready', () => {
            conn.exec(command, (err, stream) => {
                if (err) { clearTimeout(timeout); conn.end(); reject(err); return; }
                let stdout = '';
                let stderr = '';
                stream.on('close', (code: number) => { clearTimeout(timeout); conn.end(); resolve({ stdout, stderr, exitCode: code }); });
                stream.on('data', (d: Buffer) => { stdout += d.toString(); });
                stream.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
            });
        });
        conn.on('error', (err) => { clearTimeout(timeout); reject(err); });
        conn.connect({ host: target.host, port: target.port, username: target.username, privateKey: target.privateKey, readyTimeout: 10000 });
    });
}

/**
 * Create (or repair) the non-admin shell account, log in as it with its new key, and only
 * enable it when it provably has no admin rights. Returns the account and the id of its
 * stored key, or null (with a warning in `steps`) when it was not enabled.
 */
async function setupShellAccount(args: {
    sshConfig: SshAuth; adminPassword: string; hostname: string; port: number;
    privilegedAccount: string; shellAccount: string; replaceKeys: boolean; windows: boolean; steps: string[];
}): Promise<{ user: string; keyId: string } | null> {
    const { sshConfig, adminPassword, hostname, port, privilegedAccount, shellAccount, replaceKeys, windows, steps } = args;
    const keyName = `${hostname}-${shellAccount}`;
    const pair = generateSSHKeyPair(keyName, 'ed25519');

    let run: { stdout: string; stderr: string; exitCode: number };
    if (windows) {
        // The script restarts sshd as its last line, which can cut this connection: the marker it
        // printed before that is what counts, and the login check below is the real proof.
        try {
            run = await sshExec(sshConfig, powershellCommand(windowsShellAccountScript({ account: shellAccount, publicKey: pair.publicKey, replaceKeys })));
        } catch (err) {
            run = { stdout: '', stderr: String(err), exitCode: -1 };
        }
    } else {
        run = await sshExec(sshConfig, asRootCommand(sshConfig, adminPassword, shellAccountScript({
            account: shellAccount, privilegedAccount, publicKey: pair.publicKey, replaceKeys,
        })));
    }
    const created = windows ? run.stdout.includes('BOSUN_SHELL_OK') : run.exitCode === 0 && run.stdout.includes('BOSUN_SHELL_OK');
    if (!created) {
        const why = (windows ? run.stderr.trim() || run.stdout.trim() : stripSudo(run.stderr)) || `exit ${run.exitCode}`;
        steps.push(`${WARNING}Could not create the non-admin shell account ${shellAccount} (${why.slice(0, 240)}); API terminals and shell commands are not enabled for this host.`);
        return null;
    }

    // Log in as the new account with its new key, and prove it is not an administrator.
    // sshd may still be reloading its configuration (Windows restarts it), so give the first logins a few tries.
    let verification;
    let lastError: unknown = null;
    const attempts = windows ? 10 : 6;
    for (let attempt = 0; attempt < attempts && !verification; attempt++) {
        if (attempt > 0) await new Promise(r => setTimeout(r, windows ? 2500 : 1500));
        try {
            const check = await sshExecWithKey(
                { host: hostname, port, username: shellAccount, privateKey: pair.privateKey },
                windows ? powershellCommand(WINDOWS_SHELL_VERIFY_COMMAND) : SHELL_VERIFY_COMMAND,
            );
            verification = windows ? parseWindowsShellVerification(check.stdout, shellAccount) : parseShellVerification(check.stdout, shellAccount);
        } catch (err) {
            lastError = err;
        }
    }
    if (!verification) {
        steps.push(`${WARNING}Created ${shellAccount} but could not log in as it (${String(lastError).slice(0, 160)}); API terminals and shell commands are not enabled for this host.`);
        return null;
    }
    if (!verification.ok) {
        steps.push(`${WARNING}The shell account ${shellAccount} was NOT enabled because ${verification.problems.join('; ')}. Remove that access from the account (or pick another name) and run Provision again.`);
        return null;
    }

    const keyId = crypto.randomUUID();
    await rqlite.execute(
        'INSERT INTO ssh_keys (id, name, fingerprint, public_key, private_key_enc, key_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [keyId, keyName, pair.fingerprint, pair.publicKey, encrypt(pair.privateKey, getMasterKey()), 'ed25519', new Date().toISOString()]
    );
    steps.push(windows
        ? `Created the non-admin shell account ${shellAccount}: standard user, not an administrator, random password nobody knows, key-only (verified by logging in as it)`
        : `Created the non-admin shell account ${shellAccount}: no sudo, no Docker group, password locked, key-only (verified by logging in as it)`);
    if (run.stdout.includes('BOSUN_SSHD_RESTRICTED')) steps.push(`Blocked port, agent, X11 and tunnel forwarding for ${shellAccount} in sshd`);
    else if (windows) steps.push(`${WARNING}sshd was not restricted for ${shellAccount} (the sshd_config change did not validate or could not be checked, so it was left unchanged); the account still has no admin rights.`);
    else steps.push(`${WARNING}sshd was not restricted for ${shellAccount} (${run.stdout.includes('BOSUN_SSHD_NOINCLUDE') ? 'sshd_config does not include sshd_config.d' : 'the new sshd configuration did not validate, so it was left unchanged'}); the account still has no admin rights.`);
    return { user: shellAccount, keyId };
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
            replace_keys = true,
            create_shell_account = true,
            shell_account = DEFAULT_SHELL_ACCOUNT,
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

        if (create_shell_account !== false && (typeof shell_account !== 'string' || !SHELL_ACCOUNT_RE.test(shell_account) || shell_account === service_account)) {
            return NextResponse.json({
                error: { message: 'shell_account must be a lowercase unix account name (1-20 characters: letters, digits, dash, underscore) different from the service account', code: 'VALIDATION_ERROR' },
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
        const encryptedPrivateKey = encrypt(privateKey, getMasterKey());

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

        // Step 5: Replace earlier Bosun keys. Only after the new key is proven to
        // log in, so a host is never left without a working key.
        let keysRemoved: number | null = null;
        // Other keys on the host that look like an earlier Bosun's but are not labeled for this host: never removed
        // automatically; the person is asked which (if any) to remove.
        let leftoverKeys: KeyCandidate[] = [];
        if (replace_keys !== false) {
            if (!testSuccess) {
                steps.push(`${WARNING}Earlier Bosun keys were not removed because the new key could not be verified.`);
            } else {
                // Never fail the whole provisioning over this step (for example if sshd
                // is still restarting): the host is set up, the old keys just stay.
                try {
                    const plural = (n: number) => `${n} earlier Bosun key${n === 1 ? '' : 's'}`;
                    if (isWindowsHost) {
                        const pruned = await sshExec(sshConfig, powershellCommand(pruneWindowsKeysScript({ account: service_account, label: keyName, publicKey })));
                        const removed = pruned.stdout.match(/BOSUN_REMOVED=(\d+)/);
                        const lookalike = Number(pruned.stdout.match(/BOSUN_LOOKALIKE=(\d+)/)?.[1] ?? 0);
                        if (removed) {
                            keysRemoved = Number(removed[1]);
                            steps.push(keysRemoved > 0
                                ? `Removed ${plural(keysRemoved)} for ${keyName} from administrators_authorized_keys (a backup was saved next to it as .bosun-bak; any other Bosun install using them is revoked)`
                                : 'No earlier Bosun keys to remove');
                            leftoverKeys = parseCandidates(pruned.stdout);
                            if (lookalike > 0) {
                                steps.push(`${WARNING}${lookalike} other key${lookalike === 1 ? '' : 's'} in administrators_authorized_keys end in -${service_account} but are not labeled ${keyName}. They were left alone: you can choose which to remove.`);
                            }
                        } else if (pruned.stdout.includes('BOSUN_RESTORED')) {
                            steps.push(`${WARNING}Removing earlier Bosun keys failed a safety check, so administrators_authorized_keys was restored from its backup; earlier keys are still authorized.`);
                        } else {
                            const why = pruned.stdout.includes('BOSUN_NOFILE') ? 'administrators_authorized_keys was not found'
                                : pruned.stdout.includes('BOSUN_NEWKEY_MISSING') ? 'the new key was not found in administrators_authorized_keys'
                                : (pruned.stderr.trim() || pruned.stdout.trim() || `exit ${pruned.exitCode}`).slice(0, 200);
                            steps.push(`${WARNING}Could not remove earlier Bosun keys (${why}); they are still authorized.`);
                        }
                    } else {
                        const pruned = await sshExec(sshConfig, asRootCommand(sshConfig, admin_password, linuxPruneScript({ account: service_account, label: keyName, publicKey })));
                        const removed = pruned.stdout.match(/BOSUN_REMOVED=(\d+)/);
                        if (pruned.exitCode === 0 && removed) {
                            keysRemoved = Number(removed[1]);
                            steps.push(keysRemoved > 0
                                ? `Removed ${plural(keysRemoved)} for ${keyName} from ${service_account} (a backup was saved next to the file as .bosun-bak; access for any other Bosun install using them is revoked)`
                                : 'No earlier Bosun keys to remove');
                            leftoverKeys = parseCandidates(pruned.stdout);
                            if (leftoverKeys.length > 0) {
                                steps.push(`${WARNING}${leftoverKeys.length} other key${leftoverKeys.length === 1 ? '' : 's'} for ${service_account} end in -${service_account} but are not labeled ${keyName}. They were left alone: you can choose which to remove.`);
                            }
                        } else {
                            steps.push(`${WARNING}Could not remove earlier Bosun keys (${stripSudo(pruned.stderr) || `exit ${pruned.exitCode}`}); they are still authorized.`);
                        }
                    }
                } catch (err) {
                    steps.push(`${WARNING}Could not remove earlier Bosun keys (${String(err).slice(0, 200)}); they are still authorized.`);
                }
            }
        }

        // Step 5b: The non-admin shell account (Linux and Windows). API terminals and API shell commands log
        // in as this account with its own key; the privileged account above is never used for them.
        // Nothing here can fail provisioning, and the account is only enabled after Bosun has logged
        // in as it and proven it has no sudo, no admin-like group and no Docker socket access.
        let shell: { user: string; keyId: string } | null = null;
        if (create_shell_account !== false) {
            if (!testSuccess) {
                steps.push(`${WARNING}The non-admin shell account was not created because the service account could not be verified.`);
            } else {
                try {
                    shell = await setupShellAccount({ sshConfig, adminPassword: admin_password, hostname, port, privilegedAccount: service_account, shellAccount: shell_account, replaceKeys: replace_keys !== false, windows: isWindowsHost, steps });
                } catch (err) {
                    steps.push(`${WARNING}Could not set up the non-admin shell account (${String(err).slice(0, 200)}); API terminals and shell commands are not enabled for this host.`);
                }
            }
        }

        // Step 6: A host already added to this Bosun keeps its record; point it at the new key
        // (and drop the old key row if nothing else uses it) instead of creating a duplicate.
        let existingServer: { id: string; name: string } | null = null;
        if (testSuccess) {
            const found = await rqlite.query(
                'SELECT id, name, ssh_key_id, shell_key_id FROM servers WHERE LOWER(hostname) = LOWER(?) AND COALESCE(ssh_port, 22) = ? LIMIT 1',
                [hostname, Number(port) || 22]
            );
            const row = found.values?.[0] as (string | null)[] | undefined;
            if (row) {
                const [existingId, existingName, oldKeyId, oldShellKeyId] = row as string[];
                await rqlite.execute('UPDATE servers SET ssh_key_id = ?, ssh_user = ?, updated_at = ? WHERE id = ?', [keyId, service_account, now, existingId]);
                if (shell) {
                    await rqlite.execute('UPDATE servers SET shell_user = ?, shell_key_id = ? WHERE id = ?', [shell.user, shell.keyId, existingId]);
                    if (oldShellKeyId && oldShellKeyId !== shell.keyId) {
                        await rqlite.execute('DELETE FROM ssh_keys WHERE id = ? AND NOT EXISTS (SELECT 1 FROM servers WHERE ssh_key_id = ? OR shell_key_id = ?)', [oldShellKeyId, oldShellKeyId, oldShellKeyId]);
                    }
                }
                if (oldKeyId && oldKeyId !== keyId) {
                    await rqlite.execute('DELETE FROM ssh_keys WHERE id = ? AND NOT EXISTS (SELECT 1 FROM servers WHERE ssh_key_id = ? OR shell_key_id = ?)', [oldKeyId, oldKeyId, oldKeyId]);
                }
                existingServer = { id: existingId, name: existingName };
                steps.push(`This host is already added as "${existingName}"; it now uses the new key`);
            }
        }

        // Log to audit
        await rqlite.execute(
            'INSERT INTO audit_log (id, user_id, action, category, details, created_at) VALUES (?, ?, ?, ?, ?, ?)',
            [crypto.randomUUID(), (auth as any).userId, 'server.provision', 'server', JSON.stringify({ steps, service_account, platform: isWindowsHost ? 'windows' : 'linux', replace_keys: replace_keys !== false, keys_removed: keysRemoved, existing_server: existingServer?.id ?? null }), now]
        );

        return NextResponse.json({
            data: {
                ssh_key_id: keyId,
                ssh_key_name: keyName,
                service_account,
                platform: isWindowsHost ? 'windows' : 'linux',
                public_key: publicKey,
                test_success: testSuccess,
                existing_server: existingServer,
                keys_removed: keysRemoved,
                // Keys that look like an earlier Bosun's (not labeled for this host): the page asks which to remove.
                leftover_keys: leftoverKeys.map(k => ({ fingerprint: k.fingerprint, comment: k.comment })),
                shell_user: shell?.user ?? null,
                shell_key_id: shell?.keyId ?? null,
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
