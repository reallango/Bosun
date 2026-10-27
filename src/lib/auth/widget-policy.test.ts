import { describe, it, expect } from 'vitest';
import { changesCommand, mayChangeCommand, replacesCommand } from './widget-policy';

describe('widget command policy', () => {
  it('detects command changes in partial configs', () => {
    expect(changesCommand({ command: 'uptime' }, { command: 'rm -rf /' })).toBe(true);
    expect(changesCommand({ command: 'uptime' }, { command: 'uptime' })).toBe(false);
    expect(changesCommand({ command: 'uptime' }, { other: 1 })).toBe(false);
    expect(changesCommand({}, { command: 'id' })).toBe(true);
    expect(changesCommand(null, null)).toBe(false);
  });

  it('treats a removed command as a change for full replacement', () => {
    expect(replacesCommand({ command: 'uptime' }, {})).toBe(true);
    expect(replacesCommand({ command: 'uptime' }, { command: 'uptime', x: 1 })).toBe(false);
    expect(replacesCommand({}, { x: 1 })).toBe(false);
  });

  it('only admins may change commands', () => {
    expect(mayChangeCommand('admin')).toBe(true);
    expect(mayChangeCommand('operator')).toBe(false);
    expect(mayChangeCommand('viewer')).toBe(false);
  });
});
