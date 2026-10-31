# Ollama (Windows): installs Ollama as a Windows service run by nssm, or updates the files of an existing service.
# Parameters arrive as data: mode (install or update), name (the service; "Ollama" for a new install), exe (update: the
# full path of the existing ollama.exe), version ("latest" or x.y.z).
# A new install goes to C:\Ollama (bin, models, logs) and is reachable from the network on port 11434; Bosun itself only
# needs localhost. Steps print [step] lines; the last line is DONE <text> on success or ERROR: <text> on failure.
# ASCII only: PowerShell 5.1 reads a BOM-less .ps1 as ANSI.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
function Step($m) { Write-Output ('[step] ' + $m) }
try {
  $mode = $env:BOSUN_PARAM_mode
  $svc = $env:BOSUN_PARAM_name
  $version = $env:BOSUN_PARAM_version
  $listen = '0.0.0.0:11434'
  $port = '11434'
  $release = 'latest'
  if ($version -ne 'latest') { $release = 'tags/v' + $version }

  if ($mode -eq 'install') {
    $root = 'C:\Ollama'
    $bin = Join-Path $root 'bin'
    $models = Join-Path $root 'models'
    $logs = Join-Path $root 'logs'
    if (Get-Service -Name $svc -ErrorAction SilentlyContinue) { throw ('A service named ' + $svc + ' already exists') }
    New-Item -ItemType Directory -Force $bin, $models, $logs, (Join-Path $root 'dl') | Out-Null
  } else {
    $exePath = $env:BOSUN_PARAM_exe
    $bin = Split-Path -Parent $exePath
    $root = Split-Path -Parent $bin
    New-Item -ItemType Directory -Force (Join-Path $root 'dl') | Out-Null
  }
  $zip = Join-Path (Join-Path $root 'dl') 'ollama-windows-amd64.zip'

  Step 'finding the release'
  $rel = Invoke-RestMethod -Headers @{ 'User-Agent' = 'bosun' } ('https://api.github.com/repos/ollama/ollama/releases/' + $release)
  $asset = $rel.assets | Where-Object { $_.name -eq 'ollama-windows-amd64.zip' } | Select-Object -First 1
  if (-not $asset) { throw 'That release has no Windows archive' }
  Step ('downloading ' + $rel.tag_name + ' (' + [int]($asset.size / 1MB) + ' MB)')
  Invoke-WebRequest -UseBasicParsing $asset.browser_download_url -OutFile $zip
  if ($asset.digest -and $asset.digest -like 'sha256:*') {
    $got = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
    if ($got -ne $asset.digest.Substring(7).ToLower()) { Remove-Item $zip -Force; throw 'The download failed its SHA-256 check' }
    Step 'checksum verified'
  }

  if ($mode -eq 'install') {
    Step 'finding nssm'
    $nssm = $null
    foreach ($c in @((Join-Path $root 'nssm.exe'), 'C:\Ollama\nssm.exe')) { if (-not $nssm -and (Test-Path $c)) { $nssm = $c } }
    if (-not $nssm) { $g = Get-Command nssm.exe -ErrorAction SilentlyContinue; if ($g) { $nssm = $g.Source } }
    if (-not $nssm) {
      # winget first: check that it works (and try to install it when it does not), then install nssm with it.
      function Find-Winget {
        $c = @()
        $g = Get-Command winget.exe -ErrorAction SilentlyContinue; if ($g) { $c += $g.Source }
        $c += (Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\winget.exe')
        $c += @(Get-ChildItem (Join-Path $env:ProgramFiles 'WindowsApps\Microsoft.DesktopAppInstaller_*_8wekyb3d8bbwe\winget.exe') -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | ForEach-Object { $_.FullName })
        foreach ($p in $c) { if ($p -and (Test-Path $p)) { try { $v = (& $p --version 2>$null | Out-String).Trim(); if ($LASTEXITCODE -eq 0 -and $v -match '^v?\d') { return $p } } catch {} } }
        return $null
      }
      function Install-Winget {
        try { Add-AppxPackage -RegisterByFamilyName -MainPackage 'Microsoft.DesktopAppInstaller_8wekyb3d8bbwe' -ErrorAction Stop } catch {}
        if (Find-Winget) { return }
        $wd = Join-Path $env:TEMP 'bosun-winget'; New-Item -ItemType Directory -Force $wd | Out-Null
        try {
          Invoke-WebRequest -UseBasicParsing 'https://aka.ms/Microsoft.VCLibs.x64.14.00.Desktop.appx' -OutFile (Join-Path $wd 'vclibs.appx')
          Invoke-WebRequest -UseBasicParsing 'https://github.com/microsoft/microsoft-ui-xaml/releases/download/v2.8.6/Microsoft.UI.Xaml.2.8.x64.appx' -OutFile (Join-Path $wd 'xaml.appx')
          Invoke-WebRequest -UseBasicParsing 'https://aka.ms/getwinget' -OutFile (Join-Path $wd 'winget.msixbundle')
          Add-AppxPackage (Join-Path $wd 'vclibs.appx') -ErrorAction SilentlyContinue
          Add-AppxPackage (Join-Path $wd 'xaml.appx') -ErrorAction SilentlyContinue
          Add-AppxPackage (Join-Path $wd 'winget.msixbundle') -ErrorAction Stop
        } catch { Step ('could not install winget: ' + $_.Exception.Message) }
      }
      # winget works when its program runs AND its package source answers (a fresh account has no source data yet).
      function Test-WingetSource($p) { try { & $p search --id NSSM.NSSM --exact --source winget --accept-source-agreements --disable-interactivity 2>&1 | Out-Null; return ($LASTEXITCODE -eq 0) } catch { return $false } }
      function Repair-WingetSource($p) {
        try { Add-AppxPackage -Path 'https://cdn.winget.microsoft.com/cache/source.msix' -ErrorAction Stop } catch { Step ('could not install the winget source package: ' + $_.Exception.Message) }
        try { & $p source update --disable-interactivity 2>&1 | Out-Null } catch {}
      }
      Step 'checking that winget works'
      $wg = Find-Winget
      if (-not $wg) { Step 'winget is not available; trying to install it'; Install-Winget; $wg = Find-Winget }
      if ($wg -and -not (Test-WingetSource $wg)) { Step 'the winget package source is not working; repairing it'; Repair-WingetSource $wg; if (-not (Test-WingetSource $wg)) { $wg = $null } }
      if (-not $wg) { Step 'winget cannot be used on this host' }
      if ($wg) {
        Step 'installing nssm with winget'
        try { $wo = (& $wg install --id NSSM.NSSM --exact --silent --disable-interactivity --accept-package-agreements --accept-source-agreements 2>&1 | Out-String).Trim(); if ($LASTEXITCODE -ne 0) { Step ('winget said: ' + (($wo -split '\r?\n' | Select-Object -Last 3) -join ' ')) } } catch { Step ('winget could not install nssm: ' + $_.Exception.Message) }
        $roots = @((Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'), (Join-Path $env:ProgramFiles 'WinGet\Packages'), (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links')) | Where-Object { Test-Path $_ }
        $found = @(Get-ChildItem $roots -Recurse -Filter nssm.exe -ErrorAction SilentlyContinue | Where-Object { $_.FullName -match 'win64|Links' } | Select-Object -First 1)
        if ($found.Count -gt 0) { Copy-Item $found[0].FullName (Join-Path $root 'nssm.exe') -Force; $nssm = Join-Path $root 'nssm.exe' }
      }
    }
    if (-not $nssm) {
      # last resort when winget cannot be made to work: the release archive from nssm.cc
      Step 'winget did not provide nssm; downloading it from nssm.cc'
      $nz = Join-Path $env:TEMP 'nssm.zip'; $nd = Join-Path $env:TEMP 'nssm-extract'
      Invoke-WebRequest -UseBasicParsing 'https://nssm.cc/release/nssm-2.24.zip' -OutFile $nz
      if (Test-Path $nd) { Remove-Item $nd -Recurse -Force }
      Expand-Archive $nz -DestinationPath $nd -Force
      Copy-Item (Join-Path $nd 'nssm-2.24\win64\nssm.exe') (Join-Path $root 'nssm.exe') -Force
      $nssm = Join-Path $root 'nssm.exe'
    }
    Step 'unpacking'
    Expand-Archive $zip -DestinationPath $bin -Force
    Step 'creating the service'
    function Nssm { $o = & $nssm @args 2>&1; if ($LASTEXITCODE -ne 0) { throw ('nssm ' + ($args -join ' ') + ': ' + (($o | Out-String).Trim())) } }
    Nssm install $svc (Join-Path $bin 'ollama.exe') serve
    Nssm set $svc AppDirectory $bin
    Nssm set $svc AppEnvironmentExtra ('OLLAMA_HOST=' + $listen) ('OLLAMA_MODELS=' + $models)
    Nssm set $svc DisplayName $svc
    Nssm set $svc Description 'Ollama LLM server (installed by Bosun)'
    Nssm set $svc Start SERVICE_AUTO_START
    Nssm set $svc AppStdout (Join-Path $logs 'ollama.log')
    Nssm set $svc AppStderr (Join-Path $logs 'ollama.log')
    Nssm set $svc AppRotateFiles 1
    Nssm set $svc AppExit Default Restart
    Step 'starting the service'
    Start-Service -Name $svc
    # Reachable from the network: allow the port through the Windows firewall on private and domain networks, unless a rule
    # that allows it inbound already exists (an existing "Ollama 11434 LAN" rule is reused).
    Step 'checking the firewall'
    $open = @(Get-NetFirewallPortFilter -Protocol TCP | Where-Object { $_.LocalPort -eq $port } | Get-NetFirewallRule | Where-Object { $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' -and $_.Action -eq 'Allow' })
    if ($open.Count -eq 0) { New-NetFirewallRule -DisplayName ('Ollama ' + $port + ' LAN') -Direction Inbound -Action Allow -Protocol TCP -LocalPort $port -Profile Private,Domain | Out-Null; Step 'added a firewall rule for the private network' } else { Step 'a firewall rule already allows the port' }
  } else {
    $was = (Get-Service -Name $svc -ErrorAction Stop).Status
    if ($was -eq 'Running') { Step 'stopping the service'; Stop-Service -Name $svc -Force; (Get-Service -Name $svc).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(60)) }
    Step 'unpacking'
    Expand-Archive $zip -DestinationPath $bin -Force
    if ($was -eq 'Running') { Step 'starting the service'; Start-Service -Name $svc }
  }
  $ver = $null
  for ($i = 0; $i -lt 30 -and -not $ver; $i++) { Start-Sleep -Seconds 1; try { $ver = (Invoke-RestMethod -TimeoutSec 2 ('http://127.0.0.1:' + $port + '/api/version')).version } catch {} }
  if ($ver) { Write-Output ('DONE Ollama ' + $ver + ' is running') }
  elseif ($was -and $was -ne 'Running') { Write-Output 'DONE Updated (the service was left stopped)' }
  else { throw 'The service started but the API did not answer' }
} catch {
  Write-Output ('ERROR: ' + $_.Exception.Message)
  exit 1
}
