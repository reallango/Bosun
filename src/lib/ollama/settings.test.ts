import { describe, it, expect } from 'vitest';
import { validateSetting, OLLAMA_SETTINGS, SETTING_NAMES } from './settings';
import { windowsEnvScript, systemdEnvCommand, recreateRunCommand, dockerUpdateCommand } from './scripts';

describe('validateSetting', () => {
  it('lists the two managed settings', () => {
    expect(SETTING_NAMES).toEqual(['OLLAMA_CONTEXT_LENGTH', 'OLLAMA_MAX_LOADED_MODELS']);
    expect(OLLAMA_SETTINGS.every(s => s.label && s.description && s.defaultText)).toBe(true);
  });

  it('accepts whole numbers in range and normalises them', () => {
    expect(validateSetting('OLLAMA_CONTEXT_LENGTH', '16384')).toEqual({ ok: true, name: 'OLLAMA_CONTEXT_LENGTH', value: '16384' });
    expect(validateSetting('OLLAMA_CONTEXT_LENGTH', ' 08192 ')).toEqual({ ok: true, name: 'OLLAMA_CONTEXT_LENGTH', value: '8192' });
    expect(validateSetting('OLLAMA_MAX_LOADED_MODELS', 0)).toEqual({ ok: true, name: 'OLLAMA_MAX_LOADED_MODELS', value: '0' });
  });

  it('treats an empty value as "back to the default"', () => {
    expect(validateSetting('OLLAMA_CONTEXT_LENGTH', '')).toEqual({ ok: true, name: 'OLLAMA_CONTEXT_LENGTH', value: '' });
    expect(validateSetting('OLLAMA_MAX_LOADED_MODELS', null)).toEqual({ ok: true, name: 'OLLAMA_MAX_LOADED_MODELS', value: '' });
  });

  it('refuses unknown settings, non-numbers and values out of range', () => {
    expect(validateSetting('OLLAMA_HOST', '0.0.0.0')).toMatchObject({ ok: false, error: 'Unknown setting' });
    expect(validateSetting('PATH', '1')).toMatchObject({ ok: false });
    expect(validateSetting('OLLAMA_CONTEXT_LENGTH', '12; calc')).toMatchObject({ ok: false });
    expect(validateSetting('OLLAMA_CONTEXT_LENGTH', '-5')).toMatchObject({ ok: false });
    expect(validateSetting('OLLAMA_CONTEXT_LENGTH', '100')).toMatchObject({ ok: false });
    expect(validateSetting('OLLAMA_MAX_LOADED_MODELS', '65')).toMatchObject({ ok: false });
  });
});

describe('windowsEnvScript', () => {
  it('rewrites nssm AppEnvironmentExtra keeping the other variables, then restarts the service', () => {
    const s = windowsEnvScript('nssm', 'Ollama', 'OLLAMA_CONTEXT_LENGTH', '16384');
    expect(s).toContain("$name = 'OLLAMA_CONTEXT_LENGTH'; $val = '16384'");
    expect(s).toContain('AppEnvironmentExtra');
    expect(s).toContain("$_ -notlike ($name + '=*')");
    expect(s).toContain('& $nssm set $svc AppEnvironmentExtra @new');
    expect(s).toContain('Restart-Service');
    expect(s).toContain("Write-Output ('ERROR: '");
  });

  it('resets the nssm value when nothing is left, and removes a setting with an empty value', () => {
    const s = windowsEnvScript('nssm', 'Ollama', 'OLLAMA_MAX_LOADED_MODELS', '');
    expect(s).toContain("$val = ''");
    expect(s).toContain('& $nssm reset $svc AppEnvironmentExtra');
  });

  it('uses the Environment value of a plain Windows service', () => {
    const s = windowsEnvScript('windows', 'Ollama', 'OLLAMA_CONTEXT_LENGTH', '8192');
    expect(s).toContain('-Name Environment -Value $new -Type MultiString');
    expect(s).not.toContain('nssm set');
  });

  it('refuses a bad service name, setting or value', () => {
    expect(() => windowsEnvScript('nssm', "x'; calc", 'OLLAMA_CONTEXT_LENGTH', '8192')).toThrow(/service/);
    expect(() => windowsEnvScript('nssm', 'Ollama', 'OLLAMA_HOST', '0.0.0.0')).toThrow();
    expect(() => windowsEnvScript('nssm', 'Ollama', 'OLLAMA_CONTEXT_LENGTH', "1'; calc; '")).toThrow();
  });
});

describe('systemdEnvCommand', () => {
  it('keeps the other Bosun settings in the last-sorting drop-in, adds this one, reloads and restarts', () => {
    const c = systemdEnvCommand('ollama', 'OLLAMA_CONTEXT_LENGTH', '16384');
    expect(c).toContain('/etc/systemd/system/ollama.service.d/zz-bosun-settings.conf');
    expect(c).toContain(`grep -v '^Environment="OLLAMA_CONTEXT_LENGTH='`);
    expect(c).toContain(`echo 'Environment="OLLAMA_CONTEXT_LENGTH=16384"'`);
    expect(c).toContain('systemctl daemon-reload && sudo -n systemctl restart');
  });

  it('only removes the line when the value is empty, and refuses anything unsafe', () => {
    expect(systemdEnvCommand('ollama', 'OLLAMA_MAX_LOADED_MODELS', '')).not.toContain('echo \'Environment="OLLAMA_MAX_LOADED_MODELS=');
    expect(() => systemdEnvCommand('ollama', 'OLLAMA_CONTEXT_LENGTH', '8192"; reboot; "')).toThrow();
    expect(() => systemdEnvCommand('a b', 'OLLAMA_CONTEXT_LENGTH', '8192')).toThrow(/unit/);
  });
});

describe('changing a setting of a container', () => {
  const inspect = {
    Config: { Image: 'ollama/ollama:0.40.13', Env: ['PATH=/usr/bin', 'OLLAMA_HOST=0.0.0.0:11434', 'OLLAMA_CONTEXT_LENGTH=4096', 'OLLAMA_MAX_LOADED_MODELS=2'], Labels: {} },
    HostConfig: { RestartPolicy: { Name: 'always' }, PortBindings: { '11434/tcp': [{ HostIp: '', HostPort: '11434' }] }, NetworkMode: 'bridge' },
    Mounts: [{ Type: 'volume', Name: 'ollama', Destination: '/root/.ollama', RW: true }],
  };

  it('replaces the one setting and keeps everything else', () => {
    const c = recreateRunCommand(inspect, 'ollama/ollama:0.40.13', 'ollama', { env: { OLLAMA_CONTEXT_LENGTH: '16384' } });
    expect(c).toContain("-e 'OLLAMA_CONTEXT_LENGTH=16384'");
    expect(c).not.toContain('OLLAMA_CONTEXT_LENGTH=4096');
    expect(c).toContain("-e 'OLLAMA_MAX_LOADED_MODELS=2'");
    expect(c).toContain("-e 'OLLAMA_HOST=0.0.0.0:11434'");
    expect(c).toContain('--restart always');
    expect(c).toContain("-v 'ollama:/root/.ollama'");
  });

  it('removes a setting that is reset to its default', () => {
    const c = recreateRunCommand(inspect, 'ollama/ollama:0.40.13', 'ollama', { env: { OLLAMA_MAX_LOADED_MODELS: '' } });
    expect(c).not.toContain('OLLAMA_MAX_LOADED_MODELS');
    expect(c).toContain("-e 'OLLAMA_CONTEXT_LENGTH=4096'");
  });

  it('refuses a value that is not a valid setting', () => {
    expect(() => recreateRunCommand(inspect, 'ollama/ollama:0.40.13', 'ollama', { env: { OLLAMA_CONTEXT_LENGTH: 'x y' } })).toThrow();
    expect(() => recreateRunCommand(inspect, 'ollama/ollama:0.40.13', 'ollama', { env: { PATH: '1' } })).toThrow();
  });

  it('recreates without pulling when only a setting changes', () => {
    const run = recreateRunCommand(inspect, 'ollama/ollama:0.40.13', 'ollama', { env: { OLLAMA_CONTEXT_LENGTH: '8192' } });
    expect(dockerUpdateCommand('ollama', 'ollama/ollama:0.40.13', run, { pull: false })).not.toContain('$D pull');
    expect(dockerUpdateCommand('ollama', 'ollama/ollama:0.40.13', run)).toContain('$D pull');
  });
});
