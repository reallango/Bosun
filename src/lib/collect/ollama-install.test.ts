import { describe, it, expect } from 'vitest';
import { parseInstall } from './ollama-install';
import * as linux from './linux';

const parseOllama = (linux as unknown as { _parsers: { parseOllama: (t: string) => any } })._parsers.parseOllama;

describe('parseInstall', () => {
  it('reads an nssm service on Windows with its startup type and executable', () => {
    const i = parseInstall('SVC_NAME=Ollama\nSVC_STATE=Running\nSVC_START=Manual\nSVC_DELAYED=False\nSVC_WRAPPER=nssm\nSVC_EXE=C:/Ollama/bin/ollama.exe\n', true);
    expect(i).toMatchObject({ kind: 'service', manager: 'nssm', name: 'Ollama', state: 'running', startMode: 'manual', exe: 'C:/Ollama/bin/ollama.exe' });
  });

  it('tells delayed automatic start from automatic, and a stopped or disabled service', () => {
    expect(parseInstall('SVC_NAME=Ollama\nSVC_STATE=Stopped\nSVC_START=Auto\nSVC_DELAYED=True', false)).toMatchObject({ state: 'stopped', startMode: 'delayed' });
    expect(parseInstall('SVC_NAME=Ollama\nSVC_STATE=Running\nSVC_START=Auto\nSVC_DELAYED=False', true).startMode).toBe('auto');
    expect(parseInstall('SVC_NAME=Ollama\nSVC_STATE=Running\nSVC_START=Disabled', true).startMode).toBe('disabled');
  });

  it('reads a Docker container with its restart policy', () => {
    const i = parseInstall('DOCKER_AVAILABLE=1\nDOCKER_NAME=ollama\nDOCKER_STATE=running\nDOCKER_RESTART=unless-stopped\nDOCKER_IMAGE=ollama/ollama:latest', true);
    expect(i).toEqual({ dockerAvailable: true, kind: 'docker', container: 'ollama', image: 'ollama/ollama:latest', state: 'running', restartPolicy: 'unless-stopped', env: {} });
  });

  it('reads a systemd unit on the host', () => {
    expect(parseInstall('DOCKER_AVAILABLE=0\nHOST_BIN=/usr/local/bin/ollama\nUNIT=ollama\nUNIT_ACTIVE=active\nUNIT_ENABLED=enabled', true))
      .toMatchObject({ kind: 'service', manager: 'systemd', name: 'ollama', state: 'running', startMode: 'enabled', dockerAvailable: false });
    expect(parseInstall('UNIT=ollama\nUNIT_ACTIVE=failed\nUNIT_ENABLED=disabled', false)).toMatchObject({ state: 'failed', startMode: 'disabled' });
  });

  it('calls a binary without a service a standard install, and nothing at all none', () => {
    expect(parseInstall('DOCKER_AVAILABLE=1\nHOST_BIN=/usr/local/bin/ollama', false)).toMatchObject({ kind: 'standard', path: '/usr/local/bin/ollama' });
    expect(parseInstall('STANDARD_PATH=C:/Users/x/AppData/Local/Programs/Ollama/ollama.exe', true)).toMatchObject({ kind: 'standard' });
    expect(parseInstall('DOCKER_AVAILABLE=1', false)).toEqual({ dockerAvailable: true, kind: 'none' });
    expect(parseInstall('', false)).toEqual({ dockerAvailable: false, kind: 'none' });
  });

  it('refuses names that are not plain identifiers', () => {
    expect(parseInstall('SVC_NAME=Ollama; calc\nSVC_STATE=Running', true).kind).not.toBe('service');
    expect(parseInstall('DOCKER_NAME=a b;c\nDOCKER_STATE=running', false).kind).not.toBe('docker');
  });
});

describe('parseOllama with the install block', () => {
  const api = '{"version":"0.40.10"}\n{"models":[]}\n{"models":[]}';
  it('adds the install when the probe printed it', () => {
    const o = parseOllama(`${api}\n@@INSTALL\nDOCKER_AVAILABLE=1\nDOCKER_NAME=ollama\nDOCKER_STATE=running\nDOCKER_RESTART=always\nDOCKER_IMAGE=ollama/ollama`);
    expect(o.status).toBe('running');
    expect(o.version).toBe('0.40.10');
    expect(o.install).toMatchObject({ kind: 'docker', restartPolicy: 'always' });
  });

  it('still reports the install when the API is down', () => {
    const o = parseOllama('DOWN\n@@INSTALL\nSVC_NAME=Ollama\nSVC_STATE=Stopped\nSVC_START=Auto');
    expect(o.status).toBe('stopped');
    expect(o.install).toMatchObject({ kind: 'service', state: 'stopped' });
  });

  it('keeps working with older probe output that has no install block', () => {
    expect(parseOllama(api).install).toBeUndefined();
    expect(parseOllama('DOWN')).toMatchObject({ status: 'stopped' });
  });
});

describe('Windows line endings', () => {
  it('finds the install block when the probe output uses CRLF', () => {
    const o = parseOllama('{"version":"0.40.10"}\r\n{"models":[]}\r\n{"models":[]}\r\n@@INSTALL\r\nSVC_NAME=Ollama\r\nSVC_STATE=Running\r\nSVC_START=Manual\r\nSVC_WRAPPER=nssm\r\nSVC_EXE=C:/Ollama/bin/ollama.exe\r\n');
    expect(o.version).toBe('0.40.10');
    expect(o.install).toMatchObject({ kind: 'service', manager: 'nssm', name: 'Ollama', startMode: 'manual' });
  });
});

describe('nothing installed', () => {
  it('reports "none" when the install block is empty (Windows prints nothing after the marker)', () => {
    const o = parseOllama('DOWN\n@@INSTALL');
    expect(o.status).toBe('stopped');
    expect(o.install).toEqual({ dockerAvailable: false, kind: 'none' });
    expect(parseOllama('DOWN\r\n@@INSTALL\r\n').install).toEqual({ dockerAvailable: false, kind: 'none' });
  });
});

describe('configured settings', () => {
  it('reads the settings Bosun manages from each kind of install, and ignores anything that is not a number', () => {
    const win = parseInstall('SVC_NAME=Ollama\nSVC_STATE=Running\nSVC_START=Auto\nSVC_WRAPPER=nssm\nENV_OLLAMA_CONTEXT_LENGTH=16384\nENV_OLLAMA_MAX_LOADED_MODELS=1', true);
    expect(win.env).toEqual({ OLLAMA_CONTEXT_LENGTH: '16384', OLLAMA_MAX_LOADED_MODELS: '1' });
    expect(parseInstall('UNIT=ollama\nUNIT_ACTIVE=active\nENV_OLLAMA_CONTEXT_LENGTH=8192', true).env).toEqual({ OLLAMA_CONTEXT_LENGTH: '8192' });
    expect(parseInstall('DOCKER_NAME=ollama\nDOCKER_STATE=running\nENV_OLLAMA_MAX_LOADED_MODELS=2', true).env).toEqual({ OLLAMA_MAX_LOADED_MODELS: '2' });
    expect(parseInstall('UNIT=ollama\nUNIT_ACTIVE=active\nENV_OLLAMA_CONTEXT_LENGTH=abc;rm', true).env).toEqual({});
    expect(parseInstall('UNIT=ollama\nUNIT_ACTIVE=active', true).env).toEqual({});
  });
});
