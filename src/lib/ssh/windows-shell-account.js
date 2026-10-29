'use strict';

/**
 * The non-admin ("shell") account on Windows hosts: the counterpart of shell-account.js.
 * API terminals and API shell commands log in as THIS account with its own key, so a caller
 * has no administrator rights and no key to the service account.
 *
 * Plain CommonJS with no imports (shared by the routes, ws-server.js and the tests). The scripts
 * are PowerShell 5.1 compatible and ASCII only (a BOM-less script is read as ANSI).
 */

/** SIDs of local groups that amount to administrator-like rights on Windows. */
const WINDOWS_ADMIN_LIKE_SIDS = [
  'S-1-5-32-544', // Administrators
  'S-1-5-32-549', // Server Operators
  'S-1-5-32-548', // Account Operators
  'S-1-5-32-551', // Backup Operators
  'S-1-5-32-550', // Print Operators
  'S-1-5-32-578', // Hyper-V Administrators
  'S-1-5-32-580', // Remote Management Users
];

const WINDOWS_ADMIN_LIKE_NAMES = ['administrators', 'server operators', 'account operators', 'backup operators', 'print operators', 'hyper-v administrators', 'remote management users'];

const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;

/**
 * Script (run by the Windows administrator) that creates or repairs the shell account:
 *  - a local account with a long random password that is never stored or shown (Windows will
 *    not allow a key logon for an account without one, and nobody needs to know it);
 *  - removed from every administrator-like group, a plain member of Users;
 *  - hidden from the login screen;
 *  - a real user profile (OpenSSH cannot find its key without one) holding its authorized_keys,
 *    readable only by it, SYSTEM and Administrators;
 *  - sshd told not to forward ports, agents or X11 for it (validated with `sshd -t` first, the
 *    config restored if it does not validate).
 * Prints BOSUN_SHELL_OK at the end, plus BOSUN_SSHD_RESTRICTED or BOSUN_SSHD_UNCHANGED.
 * sshd is restarted last (this drops the connection that ran the script).
 *
 * @param {{ account: string, publicKey: string, replaceKeys: boolean }} opts
 * @returns {string}
 */
function windowsShellAccountScript(opts) {
  const sids = WINDOWS_ADMIN_LIKE_SIDS.map(psq).join(',');
  return `
$ErrorActionPreference = 'Stop'
$acct = ${psq(opts.account)}
$key = ${psq(opts.publicKey)}
$replace = ${opts.replaceKeys ? '$true' : '$false'}
function New-Secret {
  $chars = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!#%+-=?'
  $b = New-Object byte[] 40
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create(); $rng.GetBytes($b); $rng.Dispose()
  $s = -join ($b | ForEach-Object { $chars[$_ % $chars.Length] })
  'Aa1!' + $s
}
$pw = ConvertTo-SecureString (New-Secret) -AsPlainText -Force
$user = Get-LocalUser -Name $acct -ErrorAction SilentlyContinue
if (-not $user) {
  New-LocalUser -Name $acct -Password $pw -PasswordNeverExpires -AccountNeverExpires -Description 'Bosun non-admin shell account' | Out-Null
} else {
  Set-LocalUser -Name $acct -Password $pw -PasswordNeverExpires $true
  Enable-LocalUser -Name $acct
}
foreach ($sid in @(${sids})) {
  try {
    $g = Get-LocalGroup -SID $sid -ErrorAction Stop
    if (Get-LocalGroupMember -Group $g -ErrorAction SilentlyContinue | Where-Object { $_.Name -like ('*\\' + $acct) }) { Remove-LocalGroupMember -Group $g -Member $acct }
  } catch { }
}
$users = Get-LocalGroup -SID 'S-1-5-32-545'
if (-not (Get-LocalGroupMember -Group $users -ErrorAction SilentlyContinue | Where-Object { $_.Name -like ('*\\' + $acct) })) { Add-LocalGroupMember -Group $users -Member $acct }
$winlogon = 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon\\SpecialAccounts\\UserList'
New-Item -Path $winlogon -Force | Out-Null
New-ItemProperty -Path $winlogon -Name $acct -Value 0 -PropertyType DWord -Force | Out-Null

# A real profile, created the supported way (a hand-made folder makes Windows create "name.HOST" later).
$sid = (Get-LocalUser -Name $acct).SID.Value
Add-Type -Namespace Bosun -Name Profile -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("userenv.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
public static extern int CreateProfile([System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.LPWStr)] string sid, [System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.LPWStr)] string name, [System.Runtime.InteropServices.Out] [System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.LPWStr)] System.Text.StringBuilder path, uint size);
'@ -ErrorAction SilentlyContinue
$sb = New-Object System.Text.StringBuilder 260
$hr = [Bosun.Profile]::CreateProfile($sid, $acct, $sb, 260)
if ($hr -ne 0 -and $hr -ne -2147024713) { throw ('CreateProfile failed: 0x' + $hr.ToString('X')) }
$home1 = (Get-ItemProperty ('HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList\\' + $sid)).ProfileImagePath
if (-not $home1 -or -not (Test-Path $home1)) { throw 'The profile folder was not created' }
$dir = Join-Path $home1 '.ssh'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$ak = Join-Path $dir 'authorized_keys'
if ($replace -or -not (Test-Path $ak)) { [System.IO.File]::WriteAllText($ak, $key + [Environment]::NewLine) }
elseif (-not ((Get-Content $ak -Raw).Contains($key))) { Add-Content -Path $ak -Value $key }
$acl = New-Object System.Security.AccessControl.FileSecurity
$acl.SetAccessRuleProtection($true, $false)
$userSid = New-Object System.Security.Principal.SecurityIdentifier($sid)
$adminsSid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')
$systemSid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')
$acl.SetOwner($userSid)
foreach ($s in @($userSid, $adminsSid, $systemSid)) { $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($s, 'FullControl', 'Allow'))) }
Set-Acl -Path $ak -AclObject $acl
$dacl = New-Object System.Security.AccessControl.DirectorySecurity
$dacl.SetAccessRuleProtection($true, $false)
$dacl.SetOwner($userSid)
foreach ($s in @($userSid, $adminsSid, $systemSid)) { $dacl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($s, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))) }
Set-Acl -Path $dir -AclObject $dacl

# sshd: no forwarding for this account.
$cfg = Join-Path $env:ProgramData 'ssh\\sshd_config'
$sshd = Join-Path $env:windir 'System32\\OpenSSH\\sshd.exe'
$marker = '# bosun-shell-' + $acct
$restricted = $false
# Everything above is the account itself. Tightening sshd is a bonus that must never undo it: whatever
# goes wrong below is swallowed and only means "not restricted". (Under 'Stop' a native command that
# writes to stderr becomes a terminating error in Windows PowerShell 5.1, so sshd is run with 'Continue'.)
function Test-SshdConfig {
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $null = & $sshd -t -f $cfg 2>&1; return ($LASTEXITCODE -eq 0) } finally { $ErrorActionPreference = $old }
}
try {
  if ((Test-Path $cfg) -and (Test-Path $sshd)) {
    $text = Get-Content $cfg -Raw
    $appended = $false
    if (-not $text.Contains($marker)) {
      Copy-Item -Path $cfg -Destination ($cfg + '.bosun-bak') -Force
      $block = [Environment]::NewLine + $marker + [Environment]::NewLine + 'Match User ' + $acct + [Environment]::NewLine + '    AllowTcpForwarding no' + [Environment]::NewLine + '    AllowAgentForwarding no' + [Environment]::NewLine + '    X11Forwarding no' + [Environment]::NewLine + '    PermitTunnel no' + [Environment]::NewLine + '    GatewayPorts no' + [Environment]::NewLine
      Add-Content -Path $cfg -Value $block
      $appended = $true
    }
    if (Test-SshdConfig) { $restricted = $true }
    elseif ($appended) { Copy-Item -Path ($cfg + '.bosun-bak') -Destination $cfg -Force }
  }
} catch { $restricted = $false }
Write-Output 'BOSUN_SHELL_OK'
if ($restricted) { Write-Output 'BOSUN_SSHD_RESTRICTED' } else { Write-Output 'BOSUN_SSHD_UNCHANGED' }
Restart-Service sshd -ErrorAction SilentlyContinue
`.trim();
}

/**
 * Command run as the shell account (with its own key) to prove it has no administrator
 * rights: not in an administrator-like group, not elevated, cannot write to the Windows
 * folder, cannot read the administrators' authorized keys.
 */
const WINDOWS_SHELL_VERIFY_COMMAND = `
$ErrorActionPreference = 'Stop'
$id = [System.Security.Principal.WindowsIdentity]::GetCurrent()
Write-Output ('WHOAMI ' + $id.Name)
Write-Output ('ADMIN ' + ([System.Security.Principal.WindowsPrincipal]$id).IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator))
$names = @()
foreach ($g in $id.Groups) { try { $names += $g.Translate([System.Security.Principal.NTAccount]).Value } catch { $names += $g.Value } }
Write-Output ('GROUPS ' + ($names -join ';'))
Write-Output ('HIGH ' + [bool](whoami /groups | Select-String 'S-1-16-12288' -Quiet))
try { $f = Join-Path $env:windir 'bosun-write-test.tmp'; [System.IO.File]::WriteAllText($f, 'x'); Remove-Item $f -Force; Write-Output 'WRITE_WINDIR YES' } catch { Write-Output 'WRITE_WINDIR NO' }
try { [System.IO.File]::ReadAllText((Join-Path $env:ProgramData 'ssh\\administrators_authorized_keys')) | Out-Null; Write-Output 'READ_ADMIN_KEYS YES' } catch { Write-Output 'READ_ADMIN_KEYS NO' }
`.trim();

/**
 * Interpret WINDOWS_SHELL_VERIFY_COMMAND's output. Unknown is never safe: anything missing is a problem.
 * @param {string} stdout
 * @param {string} expectedAccount
 * @returns {{ ok: boolean, problems: string[] }}
 */
function parseWindowsShellVerification(stdout, expectedAccount) {
  const text = String(stdout).replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
  const line = (k) => {
    const m = text.match(new RegExp(`^${k} ?(.*)$`, 'm'));
    return m ? m[1].trim() : undefined;
  };
  const problems = [];
  const who = line('WHOAMI');
  if (!who || who.split('\\').pop().toLowerCase() !== String(expectedAccount).toLowerCase()) problems.push(`it logged in as "${who ?? '?'}", not "${expectedAccount}"`);
  const admin = line('ADMIN');
  if (admin === undefined) problems.push('its administrator status could not be checked');
  else if (/^true$/i.test(admin)) problems.push('it is an administrator');
  const groups = (line('GROUPS') ?? '').split(';').map(s => s.trim()).filter(Boolean);
  if (line('GROUPS') === undefined) problems.push('its groups could not be read');
  const bad = groups.filter(g => WINDOWS_ADMIN_LIKE_NAMES.includes(g.split('\\').pop().toLowerCase()) || WINDOWS_ADMIN_LIKE_SIDS.includes(g));
  if (bad.length) problems.push(`it is in the ${bad.map(g => g.split('\\').pop()).join(', ')} group${bad.length === 1 ? '' : 's'}`);
  const high = line('HIGH');
  if (high === undefined) problems.push('its integrity level could not be checked');
  else if (/^true$/i.test(high)) problems.push('it runs at High integrity (elevated)');
  const w = line('WRITE_WINDIR');
  if (w === 'YES') problems.push('it can write to the Windows folder');
  else if (w !== 'NO') problems.push('write access to the Windows folder could not be checked');
  const r = line('READ_ADMIN_KEYS');
  if (r === 'YES') problems.push('it can read the administrators\' authorized keys');
  else if (r !== 'NO') problems.push('access to the administrators\' authorized keys could not be checked');
  return { ok: problems.length === 0, problems };
}

module.exports = {
  WINDOWS_ADMIN_LIKE_SIDS, WINDOWS_ADMIN_LIKE_NAMES, windowsShellAccountScript, WINDOWS_SHELL_VERIFY_COMMAND, parseWindowsShellVerification,
};
