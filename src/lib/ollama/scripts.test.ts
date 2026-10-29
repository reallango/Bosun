import { describe, it, expect } from 'vitest';
import {
  windowsScript, windowsServiceScript, dockerControlCommand, dockerInstallCommand, dockerUpdateCommand, hostInstallCommand,
  systemdCommand, recreateRunCommand, isNewerVersion, parseVersion, shq,
} from './scripts';

describe('windowsScript', () => {
  it('installs a service with nssm in the C:/Ollama layout, reachable from the network', () => {
    const s = windowsScript({ mode: 'install' });
    expect(s).toContain("$root = 'C:\\Ollama'");
    expect(s).toContain("OLLAMA_HOST=' + '0.0.0.0:11434'");
    expect(s).toContain('Nssm install $svc');
    expect(s).toContain('SERVICE_AUTO_START');
    expect(s).toContain('AppExit Default Restart');
    expect(s).toContain('releases/latest');
    expect(s).toContain('checksum verified');
    expect(s).toContain("throw ('A service named '");   // never overwrites an existing service
  });

  it('pins a version and can use a local archive', () => {
    expect(windowsScript({ mode: 'install', version: '0.40.10' })).toContain('releases/tags/v0.40.10');
    expect(windowsScript({ mode: 'install', zipPath: 'C:\\x\\ollama.zip' })).not.toContain('Invoke-WebRequest -UseBasicParsing $asset');
  });

  it('updates the files of an existing service and starts it again only if it was running', () => {
    const s = windowsScript({ mode: 'update', service: 'Ollama', exe: 'C:\\Ollama\\bin\\ollama.exe' });
    expect(s).toContain("$bin = Split-Path -Parent $exePath");
    expect(s).toContain("if ($was -eq 'Running') { Step 'stopping the service'");
    expect(s).not.toContain('Nssm install');
  });

  it('refuses values that are not plain names, folders, versions or addresses', () => {
    expect(() => windowsScript({ mode: 'install', service: "Ollama'; calc; '" })).toThrow(/service/);
    expect(() => windowsScript({ mode: 'install', root: 'C:\\Ollama\\..\\Windows' })).toThrow(/folder/);
    expect(() => windowsScript({ mode: 'install', root: '\\\\server\\share' })).toThrow(/folder/);
    expect(() => windowsScript({ mode: 'install', version: '1.2.3; calc' })).toThrow(/version/);
    expect(() => windowsScript({ mode: 'install', listen: '10.0.0.5:11434' })).toThrow(/listen/);
    expect(() => windowsScript({ mode: 'update', service: 'Ollama', exe: 'C:\\Windows\\notepad.exe' })).toThrow(/executable/);
  });
});

describe('windowsServiceScript', () => {
  it('starts, stops and restarts by name', () => {
    expect(windowsServiceScript('start', 'Ollama')).toContain("Start-Service -Name 'Ollama'");
    expect(windowsServiceScript('stop', 'Ollama')).toContain('Stop-Service');
    expect(windowsServiceScript('restart', 'Ollama')).toContain('Restart-Service');
  });

  it('maps startup methods to sc.exe start types, including delayed automatic', () => {
    expect(windowsServiceScript('set_startup', 'Ollama', 'auto')).toContain('start= auto');
    expect(windowsServiceScript('set_startup', 'Ollama', 'delayed')).toContain('start= delayed-auto');
    expect(windowsServiceScript('set_startup', 'Ollama', 'manual')).toContain('start= demand');
    expect(windowsServiceScript('set_startup', 'Ollama', 'disabled')).toContain('start= disabled');
    expect(() => windowsServiceScript('set_startup', 'Ollama', 'whenever')).toThrow(/startup/);
    expect(() => windowsServiceScript('start', 'a b')).toThrow(/service/);
  });
});

describe('docker commands', () => {
  it('controls the container by name and sets its restart policy', () => {
    expect(dockerControlCommand('stop', 'ollama')).toContain("$D stop 'ollama'");
    expect(dockerControlCommand('set_restart_policy', 'ollama', 'unless-stopped')).toContain('$D update --restart=unless-stopped');
    expect(() => dockerControlCommand('set_restart_policy', 'ollama', 'sometimes')).toThrow(/restart policy/);
    expect(() => dockerControlCommand('start', 'x; rm -rf /')).toThrow(/container/);
  });

  it('installs a container published on all interfaces with a volume, GPU access when available and a restart policy', () => {
    const c = dockerInstallCommand();
    expect(c).toContain('--restart unless-stopped');
    expect(c).toContain('-p 11434:11434');
    expect(c).toContain('-v ollama:/root/.ollama');
    expect(c).toContain("--gpus=all");
    expect(c).toContain('ollama/ollama:latest');
    expect(dockerInstallCommand({ version: '0.40.10' })).toContain('ollama/ollama:0.40.10');
    expect(c).toContain('Docker is not available to this account');
  });
});

describe('systemd and host install', () => {
  it('controls the unit and its enablement', () => {
    expect(systemdCommand('start', 'ollama')).toContain("sudo -n systemctl start 'ollama'");
    expect(systemdCommand('set_startup', 'ollama', 'enabled')).toBe("sudo -n systemctl enable 'ollama'");
    expect(systemdCommand('set_startup', 'ollama', 'disabled')).toBe("sudo -n systemctl disable 'ollama'");
    expect(() => systemdCommand('set_startup', 'ollama', 'static')).toThrow(/startup/);
  });

  it('uses the official script with sudo, optionally pinned', () => {
    expect(hostInstallCommand()).toContain('curl -fsSL https://ollama.com/install.sh | sudo -n sh');
    expect(hostInstallCommand('0.40.10')).toContain('sudo -n OLLAMA_VERSION=0.40.10 sh');
    expect(() => hostInstallCommand('latest; reboot')).toThrow(/version/);
  });
});

describe('recreating a container', () => {
  const inspect = {
    Config: { Image: 'ollama/ollama:0.40.10', Env: ['PATH=/usr/bin', 'OLLAMA_HOST=0.0.0.0:11434', 'NVIDIA_VISIBLE_DEVICES=all', 'SECRET=x'], Labels: {} },
    HostConfig: {
      RestartPolicy: { Name: 'unless-stopped' },
      PortBindings: { '11434/tcp': [{ HostIp: '127.0.0.1', HostPort: '11434' }] },
      NetworkMode: 'bridge',
      DeviceRequests: [{ Count: -1, Capabilities: [['gpu']] }],
    },
    Mounts: [{ Type: 'volume', Name: 'ollama', Destination: '/root/.ollama', RW: true }, { Type: 'bind', Source: '/srv/models', Destination: '/models', RW: false }],
  };

  it('keeps ports, volumes, GPU access, restart policy and Ollama environment', () => {
    const c = recreateRunCommand(inspect, 'ollama/ollama:0.40.13', 'ollama');
    expect(c).toContain("--name 'ollama'");
    expect(c).toContain('--restart unless-stopped');
    expect(c).toContain("-p '127.0.0.1:11434:11434/tcp'");
    expect(c).toContain("-v 'ollama:/root/.ollama'");
    expect(c).toContain("-v '/srv/models:/models:ro'");
    expect(c).toContain("-e 'OLLAMA_HOST=0.0.0.0:11434'");
    expect(c).toContain("-e 'NVIDIA_VISIBLE_DEVICES=all'");
    expect(c).toContain('--gpus all');
    expect(c).not.toContain('SECRET');
    expect(c).not.toContain('PATH=');
    expect(c.endsWith('ollama/ollama:0.40.13')).toBe(true);
  });

  it('refuses containers that Compose manages, and odd images', () => {
    expect(() => recreateRunCommand({ ...inspect, Config: { ...inspect.Config, Labels: { 'com.docker.compose.project': 'ai' } } }, 'ollama/ollama:latest', 'ollama')).toThrow(/Compose/);
    expect(() => recreateRunCommand(inspect, 'ollama/ollama:latest; reboot', 'ollama')).toThrow(/image/);
  });

  it('builds a replace command that puts the old container back when the new one fails', () => {
    const run = recreateRunCommand(inspect, 'ollama/ollama:0.40.13', 'ollama');
    const c = dockerUpdateCommand('ollama', 'ollama/ollama:0.40.13', run);
    expect(c).toContain("$D rename 'ollama' 'ollama-bosun-old'");
    expect(c).toContain('putting the old one back');
    expect(c).toContain("$D run -d --name 'ollama'");
  });
});

describe('versions', () => {
  it('compares x.y.z numerically', () => {
    expect(isNewerVersion('0.40.10', '0.40.13')).toBe(true);
    expect(isNewerVersion('0.9.0', '0.10.0')).toBe(true);
    expect(isNewerVersion('0.40.13', '0.40.13')).toBe(false);
    expect(isNewerVersion('0.41.0', '0.40.13')).toBe(false);
    expect(isNewerVersion(null, '0.40.13')).toBe(false);
    expect(parseVersion('ollama version is 0.40.10-rc1')).toEqual([0, 40, 10]);
  });

  it('quotes shell words', () => {
    expect(shq("it's")).toBe("'it'\\''s'");
  });
});

describe('getting nssm on Windows', () => {
  const s = windowsScript({ mode: 'install' });
  it('checks that winget works, tries to install it when it does not, and installs nssm with it', () => {
    expect(s).toContain("Step 'checking that winget works'");
    expect(s).toContain("Step 'winget is not available; trying to install it'");
    expect(s).toContain("Step 'the winget package source is not working; repairing it'");
    expect(s).toContain('https://cdn.winget.microsoft.com/cache/source.msix');
    expect(s).toContain('function Test-WingetSource');
    expect(s).toContain('--id NSSM.NSSM --exact --silent');
    expect(s).toContain('--accept-package-agreements --accept-source-agreements');
    expect(s).toContain('Add-AppxPackage');
    expect(s.indexOf('checking that winget works')).toBeLessThan(s.indexOf('installing nssm with winget'));
  });

  it('reuses an nssm that is already there, and only downloads it from nssm.cc after winget failed', () => {
    expect(s.indexOf("Join-Path $root 'nssm.exe'")).toBeLessThan(s.indexOf('winget'));
    expect(s.indexOf('installing nssm with winget')).toBeLessThan(s.indexOf('downloading it from nssm.cc'));
    expect(s).toContain("Copy-Item $found[0].FullName (Join-Path $root 'nssm.exe')");   // the service does not depend on a per-user winget folder
  });

  it('is only part of an install, never an update', () => {
    expect(windowsScript({ mode: 'update', service: 'Ollama', exe: String.raw`C:\Ollama\bin\ollama.exe` })).not.toContain('winget');
  });
});

describe('stopping a systemd unit', () => {
  it('does not treat the "inactive" report after a successful stop as a failure', () => {
    const c = systemdCommand('stop', 'ollama');
    expect(c).toContain("sudo -n systemctl stop 'ollama' && { systemctl is-active 'ollama' || true; }");
  });
});

describe('outside access for a new install', () => {
  it('Windows: listens on all interfaces and makes sure a private-network firewall rule allows the port', () => {
    const s = windowsScript({ mode: 'install' });
    expect(s).toContain("Step 'checking the firewall'");
    expect(s).toContain("New-NetFirewallRule -DisplayName 'Ollama 11434 LAN'");
    expect(s).toContain('-Profile Private,Domain');
    expect(s).toContain("'a firewall rule already allows the port'");   // an existing rule is reused
    expect(s.indexOf('Start-Service -Name $svc')).toBeLessThan(s.indexOf('checking the firewall'));
  });

  it('Windows: no firewall change for a localhost-only install, and none when updating', () => {
    expect(windowsScript({ mode: 'install', listen: '127.0.0.1:11434' })).not.toContain('NetFirewallRule');
    expect(windowsScript({ mode: 'update', service: 'Ollama', exe: String.raw`C:\Ollama\bin\ollama.exe` })).not.toContain('NetFirewallRule');
  });

  it('Linux host: a new install adds a drop-in that listens on all interfaces; an update leaves the configuration alone', () => {
    const fresh = hostInstallCommand(undefined, { listenOnNetwork: true });
    expect(fresh).toContain('/etc/systemd/system/ollama.service.d/bosun-listen.conf');
    expect(fresh).toContain('OLLAMA_HOST=0.0.0.0:11434');
    expect(fresh).toContain('systemctl daemon-reload && sudo -n systemctl restart ollama');
    expect(fresh.indexOf('install.sh')).toBeLessThan(fresh.indexOf('bosun-listen.conf'));
    expect(hostInstallCommand('0.40.13')).not.toContain('bosun-listen.conf');
  });

  it('Docker: the container publishes the port on every interface', () => {
    const c = dockerInstallCommand();
    expect(c).toContain('-p 11434:11434');
    expect(c).not.toContain('127.0.0.1:11434:11434');
  });
});
