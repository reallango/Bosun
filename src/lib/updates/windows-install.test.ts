import { describe, it, expect } from 'vitest';
import * as windows from '../collect/windows';
import { INSTALL_SCRIPT, TASK_NAME, startScript, statusScript, parseInstallStatus } from './windows-install';

const CMD_EXE_LIMIT = 8191;

const status = (task: string, result: unknown) =>
  `BOSUN_TASK ${task}\nBOSUN_RESULT ${typeof result === 'string' ? result : JSON.stringify(result)}\n`;

describe('Windows update install scripts', () => {
  it('are plain ASCII (a BOM-less .ps1 is read as ANSI by PowerShell 5.1)', () => {
    for (const s of [INSTALL_SCRIPT, startScript(), statusScript()]) {
      expect([...s].every(c => c.charCodeAt(0) < 128)).toBe(true);
    }
  });

  it('run the install as a SYSTEM scheduled task and never restart the host', () => {
    const start = startScript();
    expect(start).toContain(`'${TASK_NAME}'`);
    expect(start).toContain("-UserId 'SYSTEM'");
    expect(start).toContain('Register-ScheduledTask');
    expect(start).toContain('Start-ScheduledTask');
    expect(start).toContain('BOSUN_ALREADY_RUNNING');
    expect(start).toContain('BOSUN_STARTED');
    for (const s of [INSTALL_SCRIPT, start, statusScript()]) {
      expect(s).not.toMatch(/Restart-Computer|Stop-Computer|shutdown(\.exe)?\s/i);
    }
  });

  it('embeds exactly the install script in the starter', () => {
    const b64 = startScript().match(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/)?.[1] as string;
    expect(Buffer.from(b64, 'base64').toString('utf8')).toBe(INSTALL_SCRIPT);
  });

  it('searches, downloads, then installs, and records each step', () => {
    for (const marker of ['CreateUpdateSearcher', 'CreateUpdateDownloader', 'CreateUpdateInstaller', 'AcceptEula',
      "step = 'searching'", "step = 'downloading'", "step = 'installing'", "state = 'done'", "state = 'failed'"]) {
      expect(INSTALL_SCRIPT).toContain(marker);
    }
  });

  it('fit in one exec command', () => {
    expect(windows.powershellCommand(startScript()).length).toBeLessThan(CMD_EXE_LIMIT);
    expect(windows.powershellCommand(statusScript()).length).toBeLessThan(CMD_EXE_LIMIT);
  });
});

describe('parseInstallStatus', () => {
  it('reports progress while the task runs', () => {
    expect(parseInstallStatus(status('Running', { state: 'running', step: 'downloading', total: 4 })))
      .toMatchObject({ state: 'running', step: 'downloading', total: 4, message: 'Downloading updates…' });
    expect(parseInstallStatus(status('Running', { state: 'running', step: 'installing' })).message).toBe('Installing updates…');
  });

  it('treats a running task with no result file yet as starting', () => {
    expect(parseInstallStatus(status('Running', ''))).toMatchObject({ state: 'running', message: 'Starting…' });
  });

  it('summarises a finished install, including failures and a needed restart', () => {
    expect(parseInstallStatus(status('Ready', { state: 'done', total: 3, installed: 3, failed: 0, rebootRequired: false })))
      .toMatchObject({ state: 'done', message: 'Installed 3 of 3 updates' });
    expect(parseInstallStatus(status('None', { state: 'done', total: 5, installed: 3, failed: 2, rebootRequired: true })).message)
      .toBe('Installed 3 of 5 updates; 2 failed; a restart is needed to finish');
    expect(parseInstallStatus(status('Ready', { state: 'done', total: 1, installed: 1, failed: 0 })).message).toBe('Installed 1 of 1 update');
    expect(parseInstallStatus(status('Ready', { state: 'done', total: 0, installed: 0, failed: 0 })).message).toBe('No updates were pending');
  });

  it('reports a failure with its reason', () => {
    const s = parseInstallStatus(status('Ready', { state: 'failed', error: 'None of the updates could be downloaded' }));
    expect(s.state).toBe('failed');
    expect(s.message).toContain('None of the updates could be downloaded');
  });

  it('detects an install that was killed part-way (result still says running, task gone)', () => {
    for (const task of ['Ready', 'None', 'Disabled']) {
      expect(parseInstallStatus(status(task, { state: 'running', step: 'installing' })).state).toBe('failed');
    }
  });

  it('is idle with no task and no result, and never throws on garbage', () => {
    expect(parseInstallStatus(status('None', '')).state).toBe('idle');
    expect(parseInstallStatus('').state).toBe('idle');
    expect(parseInstallStatus(status('None', '{not json')).state).toBe('idle');
    expect(parseInstallStatus('random output\nwith no markers').state).toBe('idle');
  });
});
