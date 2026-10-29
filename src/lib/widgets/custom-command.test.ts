import { describe, it, expect } from 'vitest';
import { intervalOf, effectiveCommand, combinedOutput, WINDOWS_DEFAULT_COMMAND } from './custom-command';

describe('intervalOf', () => {
  it('defaults to 30 seconds and keeps the choice within 10-3600', () => {
    expect(intervalOf({})).toBe(30);
    expect(intervalOf(null)).toBe(30);
    expect(intervalOf({ interval: '' })).toBe(30);
    expect(intervalOf({ interval: 'soon' })).toBe(30);
    expect(intervalOf({ interval: 60 })).toBe(60);
    expect(intervalOf({ interval: '120' })).toBe(120);
    expect(intervalOf({ interval: 1 })).toBe(10);
    expect(intervalOf({ interval: 999999 })).toBe(3600);
    expect(intervalOf({ interval: 12.6 })).toBe(13);
  });
});

describe('effectiveCommand', () => {
  it('uses the saved command, and a platform default when it is empty or the stock uptime', () => {
    expect(effectiveCommand({ command: 'df -h' }, 'linux')).toBe('df -h');
    expect(effectiveCommand({ command: 'Get-Date' }, 'windows')).toBe('Get-Date');
    expect(effectiveCommand({}, 'linux')).toBe('uptime');
    expect(effectiveCommand({ command: 'uptime' }, 'linux')).toBe('uptime');
    expect(effectiveCommand({ command: 'uptime' }, 'windows')).toBe(WINDOWS_DEFAULT_COMMAND);
    expect(effectiveCommand({ command: '   ' }, 'windows')).toBe(WINDOWS_DEFAULT_COMMAND);
  });
});

describe('combinedOutput', () => {
  it('joins stdout and stderr and caps the size', () => {
    expect(combinedOutput('out\n', 'err\n')).toBe('out\nerr');
    expect(combinedOutput('', '')).toBe('');
    expect(combinedOutput('x'.repeat(100), '', 10)).toBe('x'.repeat(10));
  });
});
