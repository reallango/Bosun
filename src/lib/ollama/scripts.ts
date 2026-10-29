/**
 * Commands that install, update and control Ollama on a host. Pure string builders (no I/O, no imports) so they
 * can be tested and printed. Every value that reaches a command is validated here first: nothing the browser
 * sends is ever pasted into a shell without passing one of the patterns below.
 */

import { validateSetting } from './settings';

export const SERVICE_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
export const CONTAINER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
export const VERSION_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;
export const HOST_PORT_RE = /^(127\.0\.0\.1|0\.0\.0\.0):\d{2,5}$/;
export const RESTART_POLICIES = ['no', 'always', 'unless-stopped', 'on-failure'] as const;
export const WINDOWS_STARTUP = ['auto', 'delayed', 'manual', 'disabled'] as const;
export const SYSTEMD_STARTUP = ['enabled', 'disabled'] as const;

/** Where a new Windows install goes: the layout used by existing installs (`C:\Ollama\bin`, `models`, `logs`, `nssm.exe`). */
export const DEFAULT_WINDOWS_ROOT = 'C:\\Ollama';
export const DEFAULT_WINDOWS_SERVICE = 'Ollama';
/** A new install is reachable from the network (like the existing installs); Bosun itself only needs localhost. */
export const DEFAULT_LISTEN = '0.0.0.0:11434';

/** A PowerShell single-quoted string literal. */
const psq = (s: string) => `'${s.replace(/'/g, "''")}'`;
/** A POSIX shell single-quoted word. */
export const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

function assert(ok: boolean, message: string): void {
  if (!ok) throw Object.assign(new Error(message), { status: 400 });
}

export interface WindowsScriptOptions {
  mode: 'install' | 'update';
  service?: string;
  /** Install: the folder that gets `bin`, `models` and `logs`. Update: the folder of the existing ollama.exe (its `bin`). */
  root?: string;
  /** Update: the full path of the existing ollama.exe. */
  exe?: string;
  listen?: string;
  /** A released version such as 0.40.10; the latest release when left out. */
  version?: string;
  /** Use this local archive instead of downloading one. */
  zipPath?: string;
}

/**
 * The PowerShell that installs Ollama as a Windows service run by nssm, or updates the files of an existing
 * service. Steps print `[step]` lines; the last line is `DONE <version>` on success.
 */
export function windowsScript(o: WindowsScriptOptions): string {
  const service = o.service ?? DEFAULT_WINDOWS_SERVICE;
  const root = o.root ?? DEFAULT_WINDOWS_ROOT;
  const listen = o.listen ?? DEFAULT_LISTEN;
  assert(SERVICE_NAME_RE.test(service), 'Invalid service name');
  assert(/^[A-Za-z]:\\[A-Za-z0-9_. \\-]{1,100}$/.test(root) && !root.includes('..'), 'Invalid install folder');
  assert(HOST_PORT_RE.test(listen), 'Invalid listen address');
  if (o.version !== undefined) assert(VERSION_RE.test(o.version), 'Invalid version');
  if (o.zipPath !== undefined) assert(/^[A-Za-z]:\\[A-Za-z0-9_. \\-]{1,160}\.zip$/.test(o.zipPath) && !o.zipPath.includes('..'), 'Invalid archive path');
  if (o.mode === 'update') assert(!!o.exe && /^[A-Za-z]:\\[A-Za-z0-9_. \\-]{1,160}ollama\.exe$/i.test(o.exe) && !o.exe.includes('..'), 'Invalid executable path');
  const port = listen.split(':')[1];
  const release = o.version ? `tags/v${o.version}` : 'latest';

  const lines: string[] = [
    `$ErrorActionPreference = 'Stop'`,
    `$ProgressPreference = 'SilentlyContinue'`,
    `[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12`,
    `function Step($m) { Write-Output ('[step] ' + $m) }`,
    `$svc = ${psq(service)}`,
  ];
  if (o.mode === 'install') {
    lines.push(
      `$root = ${psq(root)}`,
      `$bin = Join-Path $root 'bin'`,
      `$models = Join-Path $root 'models'`,
      `$logs = Join-Path $root 'logs'`,
      `if (Get-Service -Name $svc -ErrorAction SilentlyContinue) { throw ('A service named ' + $svc + ' already exists') }`,
      `New-Item -ItemType Directory -Force $bin, $models, $logs, (Join-Path $root 'dl') | Out-Null`,
    );
  } else {
    lines.push(
      `$exePath = ${psq(o.exe as string)}`,
      `$bin = Split-Path -Parent $exePath`,
      `$root = Split-Path -Parent $bin`,
      `New-Item -ItemType Directory -Force (Join-Path $root 'dl') | Out-Null`,
    );
  }
  lines.push(
    `$zip = Join-Path (Join-Path $root 'dl') 'ollama-windows-amd64.zip'`,
  );

  if (o.zipPath) {
    lines.push(`Step 'using the local archive'`, `$zip = ${psq(o.zipPath)}`, `if (-not (Test-Path $zip)) { throw 'The archive was not found' }`);
  } else {
    lines.push(
      `Step 'finding the release'`,
      `$rel = Invoke-RestMethod -Headers @{ 'User-Agent' = 'bosun' } ${psq('https://api.github.com/repos/ollama/ollama/releases/' + release)}`,
      `$asset = $rel.assets | Where-Object { $_.name -eq 'ollama-windows-amd64.zip' } | Select-Object -First 1`,
      `if (-not $asset) { throw 'That release has no Windows archive' }`,
      `Step ('downloading ' + $rel.tag_name + ' (' + [int]($asset.size / 1MB) + ' MB)')`,
      `Invoke-WebRequest -UseBasicParsing $asset.browser_download_url -OutFile $zip`,
      `if ($asset.digest -and $asset.digest -like 'sha256:*') {`,
      `  $got = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()`,
      `  if ($got -ne $asset.digest.Substring(7).ToLower()) { Remove-Item $zip -Force; throw 'The download failed its SHA-256 check' }`,
      `  Step 'checksum verified'`,
      `}`,
    );
  }

  if (o.mode === 'install') {
    lines.push(
      `Step 'finding nssm'`,
      `$nssm = $null`,
      `foreach ($c in @((Join-Path $root 'nssm.exe'), ${psq(DEFAULT_WINDOWS_ROOT + '\\nssm.exe')})) { if (-not $nssm -and (Test-Path $c)) { $nssm = $c } }`,
      `if (-not $nssm) { $g = Get-Command nssm.exe -ErrorAction SilentlyContinue; if ($g) { $nssm = $g.Source } }`,
      `if (-not $nssm) {`,
      // winget first: check that it works (and try to install it when it does not), then install nssm with it.
      `  function Find-Winget {`,
      `    $c = @()`,
      `    $g = Get-Command winget.exe -ErrorAction SilentlyContinue; if ($g) { $c += $g.Source }`,
      `    $c += (Join-Path $env:LOCALAPPDATA 'Microsoft\\WindowsApps\\winget.exe')`,
      `    $c += @(Get-ChildItem (Join-Path $env:ProgramFiles 'WindowsApps\\Microsoft.DesktopAppInstaller_*_8wekyb3d8bbwe\\winget.exe') -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | ForEach-Object { $_.FullName })`,
      `    foreach ($p in $c) { if ($p -and (Test-Path $p)) { try { $v = (& $p --version 2>$null | Out-String).Trim(); if ($LASTEXITCODE -eq 0 -and $v -match '^v?\\d') { return $p } } catch {} } }`,
      `    return $null`,
      `  }`,
      `  function Install-Winget {`,
      `    try { Add-AppxPackage -RegisterByFamilyName -MainPackage 'Microsoft.DesktopAppInstaller_8wekyb3d8bbwe' -ErrorAction Stop } catch {}`,
      `    if (Find-Winget) { return }`,
      `    $wd = Join-Path $env:TEMP 'bosun-winget'; New-Item -ItemType Directory -Force $wd | Out-Null`,
      `    try {`,
      `      Invoke-WebRequest -UseBasicParsing 'https://aka.ms/Microsoft.VCLibs.x64.14.00.Desktop.appx' -OutFile (Join-Path $wd 'vclibs.appx')`,
      `      Invoke-WebRequest -UseBasicParsing 'https://github.com/microsoft/microsoft-ui-xaml/releases/download/v2.8.6/Microsoft.UI.Xaml.2.8.x64.appx' -OutFile (Join-Path $wd 'xaml.appx')`,
      `      Invoke-WebRequest -UseBasicParsing 'https://aka.ms/getwinget' -OutFile (Join-Path $wd 'winget.msixbundle')`,
      `      Add-AppxPackage (Join-Path $wd 'vclibs.appx') -ErrorAction SilentlyContinue`,
      `      Add-AppxPackage (Join-Path $wd 'xaml.appx') -ErrorAction SilentlyContinue`,
      `      Add-AppxPackage (Join-Path $wd 'winget.msixbundle') -ErrorAction Stop`,
      `    } catch { Step ('could not install winget: ' + $_.Exception.Message) }`,
      `  }`,
      // winget works when its program runs AND its package source answers (a fresh account has no source data yet).
      `  function Test-WingetSource($p) { try { & $p search --id NSSM.NSSM --exact --source winget --accept-source-agreements --disable-interactivity 2>&1 | Out-Null; return ($LASTEXITCODE -eq 0) } catch { return $false } }`,
      `  function Repair-WingetSource($p) {`,
      `    try { Add-AppxPackage -Path 'https://cdn.winget.microsoft.com/cache/source.msix' -ErrorAction Stop } catch { Step ('could not install the winget source package: ' + $_.Exception.Message) }`,
      `    try { & $p source update --disable-interactivity 2>&1 | Out-Null } catch {}`,
      `  }`,
      `  Step 'checking that winget works'`,
      `  $wg = Find-Winget`,
      `  if (-not $wg) { Step 'winget is not available; trying to install it'; Install-Winget; $wg = Find-Winget }`,
      `  if ($wg -and -not (Test-WingetSource $wg)) { Step 'the winget package source is not working; repairing it'; Repair-WingetSource $wg; if (-not (Test-WingetSource $wg)) { $wg = $null } }`,
      `  if (-not $wg) { Step 'winget cannot be used on this host' }`,
      `  if ($wg) {`,
      `    Step 'installing nssm with winget'`,
      `    try { $wo = (& $wg install --id NSSM.NSSM --exact --silent --disable-interactivity --accept-package-agreements --accept-source-agreements 2>&1 | Out-String).Trim(); if ($LASTEXITCODE -ne 0) { Step ('winget said: ' + (($wo -split '\\r?\\n' | Select-Object -Last 3) -join ' ')) } } catch { Step ('winget could not install nssm: ' + $_.Exception.Message) }`,
      `    $roots = @((Join-Path $env:LOCALAPPDATA 'Microsoft\\WinGet\\Packages'), (Join-Path $env:ProgramFiles 'WinGet\\Packages'), (Join-Path $env:LOCALAPPDATA 'Microsoft\\WinGet\\Links')) | Where-Object { Test-Path $_ }`,
      `    $found = @(Get-ChildItem $roots -Recurse -Filter nssm.exe -ErrorAction SilentlyContinue | Where-Object { $_.FullName -match 'win64|Links' } | Select-Object -First 1)`,
      `    if ($found.Count -gt 0) { Copy-Item $found[0].FullName (Join-Path $root 'nssm.exe') -Force; $nssm = Join-Path $root 'nssm.exe' }`,
      `  }`,
      `}`,
      `if (-not $nssm) {`,
      // last resort when winget cannot be made to work: the release archive from nssm.cc
      `  Step 'winget did not provide nssm; downloading it from nssm.cc'`,
      `  $nz = Join-Path $env:TEMP 'nssm.zip'; $nd = Join-Path $env:TEMP 'nssm-extract'`,
      `  Invoke-WebRequest -UseBasicParsing 'https://nssm.cc/release/nssm-2.24.zip' -OutFile $nz`,
      `  if (Test-Path $nd) { Remove-Item $nd -Recurse -Force }`,
      `  Expand-Archive $nz -DestinationPath $nd -Force`,
      `  Copy-Item (Join-Path $nd 'nssm-2.24\\win64\\nssm.exe') (Join-Path $root 'nssm.exe') -Force`,
      `  $nssm = Join-Path $root 'nssm.exe'`,
      `}`,
      `Step 'unpacking'`,
      `Expand-Archive $zip -DestinationPath $bin -Force`,
      `Step 'creating the service'`,
      `function Nssm { $o = & $nssm @args 2>&1; if ($LASTEXITCODE -ne 0) { throw ("nssm " + ($args -join " ") + ": " + (($o | Out-String).Trim())) } }`,
      `Nssm install $svc (Join-Path $bin 'ollama.exe') serve`,
      `Nssm set $svc AppDirectory $bin`,
      `Nssm set $svc AppEnvironmentExtra ('OLLAMA_HOST=' + ${psq(listen)}) ('OLLAMA_MODELS=' + $models)`,
      `Nssm set $svc DisplayName $svc`,
      `Nssm set $svc Description 'Ollama LLM server (installed by Bosun)'`,
      `Nssm set $svc Start SERVICE_AUTO_START`,
      `Nssm set $svc AppStdout (Join-Path $logs 'ollama.log')`,
      `Nssm set $svc AppStderr (Join-Path $logs 'ollama.log')`,
      `Nssm set $svc AppRotateFiles 1`,
      `Nssm set $svc AppExit Default Restart`,
      `Step 'starting the service'`,
      `Start-Service -Name $svc`,
    );
    if (listen.startsWith('0.0.0.0:')) {
      // Reachable from the network: allow the port through the Windows firewall on private and domain networks,
      // unless a rule that allows it inbound already exists (an existing "Ollama 11434 LAN" rule is reused).
      lines.push(
        `Step 'checking the firewall'`,
        `$open = @(Get-NetFirewallPortFilter -Protocol TCP | Where-Object { $_.LocalPort -eq '${port}' } | Get-NetFirewallRule | Where-Object { $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' -and $_.Action -eq 'Allow' })`,
        `if ($open.Count -eq 0) { New-NetFirewallRule -DisplayName ${psq(`Ollama ${port} LAN`)} -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${port} -Profile Private,Domain | Out-Null; Step 'added a firewall rule for the private network' } else { Step 'a firewall rule already allows the port' }`,
      );
    }
  } else {
    lines.push(
      `$was = (Get-Service -Name $svc -ErrorAction Stop).Status`,
      `if ($was -eq 'Running') { Step 'stopping the service'; Stop-Service -Name $svc -Force; (Get-Service -Name $svc).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(60)) }`,
      `Step 'unpacking'`,
      `Expand-Archive $zip -DestinationPath $bin -Force`,
      `if ($was -eq 'Running') { Step 'starting the service'; Start-Service -Name $svc }`,
    );
  }
  lines.push(
    `$ver = $null`,
    `for ($i = 0; $i -lt 30 -and -not $ver; $i++) { Start-Sleep -Seconds 1; try { $ver = (Invoke-RestMethod -TimeoutSec 2 ${psq('http://127.0.0.1:' + port + '/api/version')}).version } catch {} }`,
    `if ($ver) { Write-Output ('DONE ' + $ver) } elseif ($was -and $was -ne 'Running') { Write-Output 'DONE (service left stopped)' } else { throw 'The service started but the API did not answer' }`,
  );
  // A failure prints one plain `ERROR:` line (not a PowerShell stack trace) and exits non-zero.
  return ['try {', ...lines, `} catch { Write-Output ('ERROR: ' + $_.Exception.Message); exit 1 }`].join('\n');
}

/** `sc.exe` start types for the startup methods the widget offers. */
const SC_START: Record<string, string> = { auto: 'auto', delayed: 'delayed-auto', manual: 'demand', disabled: 'disabled' };

/** PowerShell that starts, stops or restarts a Windows service, or changes how it starts. */
export function windowsServiceScript(action: 'start' | 'stop' | 'restart' | 'set_startup', service: string, value?: string): string {
  assert(SERVICE_NAME_RE.test(service), 'Invalid service name');
  const n = psq(service);
  if (action === 'start') return `Start-Service -Name ${n}; (Get-Service -Name ${n}).Status`;
  if (action === 'stop') return `Stop-Service -Name ${n} -Force; (Get-Service -Name ${n}).Status`;
  if (action === 'restart') return `Restart-Service -Name ${n} -Force; (Get-Service -Name ${n}).Status`;
  assert(!!value && value in SC_START, 'Invalid startup method');
  return `$o = & sc.exe config ${n} start= ${SC_START[value as string]}; if ($LASTEXITCODE -ne 0) { throw ($o -join ' ') }; $o -join ' '`;
}

/** Shell that picks `docker` or, when the account needs it, `sudo -n docker`, and stops if neither works. */
const DOCKER_PICK = `D=docker; $D ps >/dev/null 2>&1 || { command -v sudo >/dev/null 2>&1 && sudo -n docker ps >/dev/null 2>&1 && D='sudo -n docker'; }; $D ps >/dev/null 2>&1 || { echo 'Docker is not available to this account' >&2; exit 3; }`;
const dockerPick = () => DOCKER_PICK.replace(/\$D ps/g, '$D ps').replace(/^D=docker; /, 'D=docker; ');

/** Start, stop or restart the container, or change its restart policy. */
export function dockerControlCommand(action: 'start' | 'stop' | 'restart' | 'set_restart_policy', container: string, value?: string): string {
  assert(CONTAINER_NAME_RE.test(container), 'Invalid container name');
  const c = shq(container);
  if (action === 'set_restart_policy') {
    assert(!!value && (RESTART_POLICIES as readonly string[]).includes(value), 'Invalid restart policy');
    return `${dockerPick()}; $D update --restart=${value} ${c}`;
  }
  return `${dockerPick()}; $D ${action} ${c}`;
}

/** Run Ollama as a Docker container: the default on Linux. Listens on the host's loopback only, keeps models in a volume. */
export function dockerInstallCommand(opts: { version?: string; container?: string } = {}): string {
  const container = opts.container ?? 'ollama';
  assert(CONTAINER_NAME_RE.test(container), 'Invalid container name');
  if (opts.version !== undefined) assert(VERSION_RE.test(opts.version), 'Invalid version');
  const image = `ollama/ollama:${opts.version ?? 'latest'}`;
  return [
    dockerPick(),
    `$D ps -a --format '{{.Names}}' | grep -qx ${shq(container)} && { echo 'A container named ${container} already exists' >&2; exit 4; }`,
    `GPU=''; $D info 2>/dev/null | grep -qi nvidia && GPU='--gpus=all'`,
    `echo '[step] pulling ${image}'`,
    `$D pull ${image}`,
    `echo '[step] starting the container'`,
    `$D run -d --name ${shq(container)} --restart unless-stopped $GPU -p 11434:11434 -v ollama:/root/.ollama ${image}`,
    `i=0; while [ $i -lt 30 ]; do v=$(curl -s -m 2 http://127.0.0.1:11434/api/version) && [ -n "$v" ] && { echo "DONE $v"; exit 0; }; i=$((i+1)); sleep 1; done`,
    `echo 'The container started but the API did not answer' >&2; exit 5`,
  ].join('\n');
}

/** Install or update Ollama on the host with the official script (creates the systemd service). Needs passwordless sudo. */
export function hostInstallCommand(version?: string, opts: { listenOnNetwork?: boolean } = {}): string {
  if (version !== undefined) assert(VERSION_RE.test(version), 'Invalid version');
  const env = version ? `OLLAMA_VERSION=${version} ` : '';
  const listen = opts.listenOnNetwork ? [
    // The official script listens on localhost only. A drop-in makes a new install reachable from the network; an
    // update leaves whatever the host has configured alone.
    `echo '[step] making Ollama reachable from the network'`,
    `sudo -n mkdir -p /etc/systemd/system/ollama.service.d`,
    `printf '[Service]\\nEnvironment="OLLAMA_HOST=${DEFAULT_LISTEN}"\\n' | sudo -n tee /etc/systemd/system/ollama.service.d/bosun-listen.conf >/dev/null`,
    `sudo -n systemctl daemon-reload && sudo -n systemctl restart ollama`,
  ] : [];
  return [
    `sudo -n true 2>/dev/null || { echo 'This account needs passwordless sudo to install Ollama on the host' >&2; exit 3; }`,
    `command -v curl >/dev/null 2>&1 || { echo 'curl is required' >&2; exit 3; }`,
    `echo '[step] running the official install script'`,
    `curl -fsSL https://ollama.com/install.sh | sudo -n ${env}sh`,
    ...listen,
    `i=0; while [ $i -lt 30 ]; do v=$(curl -s -m 2 http://127.0.0.1:11434/api/version) && [ -n "$v" ] && { echo "DONE $v"; exit 0; }; i=$((i+1)); sleep 1; done`,
    `echo 'DONE (service not answering yet)'`,
  ].join('\n');
}

/** systemd unit control on the host. */
export function systemdCommand(action: 'start' | 'stop' | 'restart' | 'set_startup', unit: string, value?: string): string {
  assert(SERVICE_NAME_RE.test(unit), 'Invalid unit name');
  if (action === 'set_startup') {
    assert(!!value && (SYSTEMD_STARTUP as readonly string[]).includes(value), 'Invalid startup method');
    return `sudo -n systemctl ${value === 'enabled' ? 'enable' : 'disable'} ${shq(unit)}`;
  }
  // `is-active` exits non-zero for a stopped unit, which is the expected result of "stop": it only reports the state.
  return `sudo -n systemctl ${action} ${shq(unit)} && { systemctl is-active ${shq(unit)} || true; }`;
}

/**
 * PowerShell that sets (or, with an empty value, removes) one of the managed settings on a Windows service and
 * restarts the service if it was running. nssm keeps the settings in AppEnvironmentExtra, a plain service in its
 * Environment value; the other variables the service already has (OLLAMA_HOST, OLLAMA_MODELS, ...) are kept.
 */
export function windowsEnvScript(manager: 'nssm' | 'windows', service: string, name: string, value: string): string {
  assert(SERVICE_NAME_RE.test(service), 'Invalid service name');
  const v = validateSetting(name, value);
  assert(v.ok, v.ok ? '' : v.error);
  if (!v.ok) throw new Error(v.error);
  const body = [
    `$ErrorActionPreference = 'Stop'`,
    `$svc = ${psq(service)}; $name = ${psq(v.name)}; $val = ${psq(v.value)}`,
    `$key = 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\' + $svc`,
  ];
  if (manager === 'nssm') {
    body.push(
      `$wmi = Get-CimInstance Win32_Service -Filter ("Name='" + $svc + "'")`,
      `$nssm = ($wmi.PathName -replace '^"?([^"]+?)"?(\\s.*)?$', '$1')`,
      `if (-not (Test-Path $nssm)) { throw 'nssm was not found where the service says it is' }`,
      `$cur = @((Get-ItemProperty ($key + '\\Parameters')).AppEnvironmentExtra)`,
      `$new = @($cur | Where-Object { $_ -and ($_ -notlike ($name + '=*')) })`,
      `if ($val -ne '') { $new += ($name + '=' + $val) }`,
      `if ($new.Count -gt 0) { $o = & $nssm set $svc AppEnvironmentExtra @new 2>&1 } else { $o = & $nssm reset $svc AppEnvironmentExtra 2>&1 }`,
      `if ($LASTEXITCODE -ne 0) { throw ('nssm: ' + (($o | Out-String).Trim())) }`,
    );
  } else {
    body.push(
      `$cur = @((Get-ItemProperty $key).Environment)`,
      `$new = @($cur | Where-Object { $_ -and ($_ -notlike ($name + '=*')) })`,
      `if ($val -ne '') { $new += ($name + '=' + $val) }`,
      `if ($new.Count -gt 0) { Set-ItemProperty -Path $key -Name Environment -Value $new -Type MultiString } else { Remove-ItemProperty -Path $key -Name Environment -ErrorAction SilentlyContinue }`,
    );
  }
  body.push(
    `if ((Get-Service -Name $svc).Status -eq 'Running') { Restart-Service -Name $svc -Force; (Get-Service -Name $svc).WaitForStatus('Running', [TimeSpan]::FromSeconds(60)); Write-Output ('Applied and restarted: ' + $name + ($(if ($val -ne '') { '=' + $val } else { ' removed' }))) } else { Write-Output ('Saved (the service is stopped): ' + $name) }`,
  );
  return ['try {', ...body, `} catch { Write-Output ('ERROR: ' + $_.Exception.Message); exit 1 }`].join('\n');
}

/**
 * Sets (or removes) one of the managed settings of a systemd service in a drop-in that sorts last, so it wins over
 * the other files, then reloads systemd and restarts the unit. The drop-in holds only Bosun's settings.
 */
export function systemdEnvCommand(unit: string, name: string, value: string): string {
  assert(SERVICE_NAME_RE.test(unit), 'Invalid unit name');
  const v = validateSetting(name, value);
  assert(v.ok, v.ok ? '' : v.error);
  if (!v.ok) throw new Error(v.error);
  const dir = `/etc/systemd/system/${unit}.service.d`;
  const file = `${dir}/zz-bosun-settings.conf`;
  return [
    `sudo -n true 2>/dev/null || { echo 'This account needs passwordless sudo to change the service' >&2; exit 3; }`,
    `sudo -n mkdir -p ${shq(dir)}`,
    `tmp=$(mktemp)`,
    `{ echo '[Service]'; if sudo -n test -f ${shq(file)}; then sudo -n cat ${shq(file)} | grep '^Environment=' | grep -v '^Environment="${v.name}=' || true; fi;` +
      (v.value !== '' ? ` echo 'Environment="${v.name}=${v.value}"';` : '') + ` } > "$tmp"`,
    `sudo -n install -m 0644 "$tmp" ${shq(file)} && rm -f "$tmp"`,
    `sudo -n systemctl daemon-reload && sudo -n systemctl restart ${shq(unit)} && { systemctl is-active ${shq(unit)} || true; }`,
  ].join('\n');
}

// ---- Recreating a container with a newer image ------------------------------------------------------------

interface InspectJson {
  Name?: string;
  Config?: { Image?: string; Env?: string[]; Labels?: Record<string, string> };
  HostConfig?: {
    RestartPolicy?: { Name?: string; MaximumRetryCount?: number };
    PortBindings?: Record<string, { HostIp?: string; HostPort?: string }[] | null>;
    Binds?: string[] | null;
    NetworkMode?: string;
    DeviceRequests?: { Count?: number; DeviceIDs?: string[] | null; Capabilities?: string[][] }[] | null;
  };
  Mounts?: { Type?: string; Name?: string; Source?: string; Destination?: string; RW?: boolean }[];
}

/**
 * The `docker run` that recreates a container from its `docker inspect` output with another image: same name,
 * published ports, volumes and bind mounts, Ollama and NVIDIA environment, GPU access, restart policy and network.
 * Containers that belong to a Compose project are refused (update those with Compose).
 */
export function recreateRunCommand(inspect: InspectJson, image: string, name: string, opts: { env?: Record<string, string> } = {}): string {
  assert(CONTAINER_NAME_RE.test(name), 'Invalid container name');
  // Settings to change: an empty value removes the variable from the new container.
  const overrides: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    const s = validateSetting(k, v);
    assert(s.ok, s.ok ? '' : s.error);
    if (s.ok) overrides[s.name] = s.value;
  }
  assert(/^[a-z0-9][a-z0-9._/-]{0,100}:[A-Za-z0-9._-]{1,60}$/.test(image), 'Invalid image');
  const labels = inspect.Config?.Labels ?? {};
  assert(!labels['com.docker.compose.project'], 'This container is managed by Docker Compose; update it with Compose');
  const hc = inspect.HostConfig ?? {};
  const args: string[] = ['docker', 'run', '-d', '--name', shq(name)];
  const rp = hc.RestartPolicy?.Name;
  if (rp && (RESTART_POLICIES as readonly string[]).includes(rp) && rp !== 'no') {
    args.push('--restart', rp === 'on-failure' && hc.RestartPolicy?.MaximumRetryCount ? `on-failure:${Number(hc.RestartPolicy.MaximumRetryCount) | 0}` : rp);
  }
  const net = hc.NetworkMode;
  if (net === 'host') args.push('--network', 'host');
  else if (net && net !== 'default' && net !== 'bridge' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(net)) args.push('--network', shq(net));
  if (net !== 'host') {
    for (const [port, binds] of Object.entries(hc.PortBindings ?? {})) {
      assert(/^\d{1,5}\/(tcp|udp)$/.test(port), 'Unexpected port mapping');
      for (const b of binds ?? []) {
        const ip = b.HostIp && /^[0-9a-fA-F:.]+$/.test(b.HostIp) && b.HostIp !== '0.0.0.0' ? `${b.HostIp.includes(':') ? `[${b.HostIp}]` : b.HostIp}:` : '';
        assert(/^\d{0,5}$/.test(b.HostPort ?? ''), 'Unexpected port mapping');
        args.push('-p', shq(`${ip}${b.HostPort ?? ''}:${port}`));
      }
    }
  }
  for (const m of inspect.Mounts ?? []) {
    if (!m.Destination || !m.Destination.startsWith('/')) continue;
    const src = m.Type === 'volume' ? m.Name : m.Type === 'bind' ? m.Source : null;
    if (!src) continue;
    args.push('-v', shq(`${src}:${m.Destination}${m.RW === false ? ':ro' : ''}`));
  }
  for (const e of inspect.Config?.Env ?? []) {
    if (!/^(OLLAMA_[A-Z0-9_]+|NVIDIA_[A-Z0-9_]+|CUDA_VISIBLE_DEVICES)=/.test(e)) continue;
    if (e.split('=')[0] in overrides) continue;   // replaced (or removed) below
    args.push('-e', shq(e));
  }
  for (const [k, v] of Object.entries(overrides)) if (v !== '') args.push('-e', shq(`${k}=${v}`));
  for (const d of hc.DeviceRequests ?? []) {
    const gpu = (d.Capabilities ?? []).some(c => c.includes('gpu'));
    if (!gpu) continue;
    if (d.DeviceIDs && d.DeviceIDs.length) args.push('--gpus', shq(`"device=${d.DeviceIDs.join(',')}"`));
    else args.push('--gpus', d.Count && d.Count > 0 ? String(d.Count) : 'all');
  }
  args.push(image);
  return args.join(' ');
}

/**
 * Update a container: pull the image, move the old container aside, start a new one from the same settings and
 * remove the old one; if the new one fails to start the old one is put back. `runCommand` comes from
 * `recreateRunCommand`.
 */
export function dockerUpdateCommand(container: string, image: string, runCommand: string, opts: { pull?: boolean } = {}): string {
  assert(CONTAINER_NAME_RE.test(container), 'Invalid container name');
  const c = shq(container);
  const old = shq(`${container}-bosun-old`);
  const run = runCommand.replace(/^docker /, '$D ');
  // Changing a setting recreates the container from the image it already has: no pull, so nothing else changes.
  const pull = opts.pull === false ? [] : [`echo '[step] pulling ${image}'`, `$D pull ${image} || exit 6`];
  return [
    dockerPick(),
    ...pull,
    `echo '[step] replacing the container'`,
    `$D rm -f ${old} >/dev/null 2>&1`,
    `$D stop ${c} >/dev/null && $D rename ${c} ${old} || exit 7`,
    `if ${run} >/dev/null; then`,
    `  $D rm ${old} >/dev/null`,
    `  i=0; while [ $i -lt 30 ]; do v=$(curl -s -m 2 http://127.0.0.1:11434/api/version) && [ -n "$v" ] && { echo "DONE $v"; exit 0; }; i=$((i+1)); sleep 1; done`,
    `  echo 'DONE (the API is not answering yet)'; exit 0`,
    `else`,
    `  echo 'The new container failed to start; putting the old one back' >&2`,
    `  $D rename ${old} ${c} && $D start ${c} >/dev/null; exit 8`,
    `fi`,
  ].join('\n');
}

/** The first `x.y.z` in a version string (for comparing what runs with what is released). */
export function parseVersion(v: unknown): [number, number, number] | null {
  const m = String(v ?? '').match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Is `latest` newer than `current`? False when either is unknown. */
export function isNewerVersion(current: unknown, latest: unknown): boolean {
  const a = parseVersion(current);
  const b = parseVersion(latest);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return b[i] > a[i];
  return false;
}
