import { describe, it, expect } from 'vitest';
import { guardedChanges } from './config-guard';

const schema = [
  { key: 'command', label: 'Command', requires_permission: 'commands.run' },
  { key: 'interval', label: 'Repeat every' },
];

describe('guardedChanges', () => {
  it('only looks at settings that name a permission', () => {
    expect(guardedChanges(schema, { command: 'uptime' }, { interval: 60 })).toEqual([]);
    expect(guardedChanges(undefined, {}, { command: 'x' })).toEqual([]);
  });
  it('reports a guarded setting that gets another value', () => {
    expect(guardedChanges(schema, { command: 'uptime' }, { command: 'df -h' })).toEqual([{ key: 'command', label: 'Command', permission: 'commands.run' }]);
  });
  it('sending the same value again is not a change (numbers and text compare as text)', () => {
    expect(guardedChanges(schema, { command: 'uptime' }, { command: 'uptime', interval: 30 })).toEqual([]);
    expect(guardedChanges([{ key: 'n', requires_permission: 'p' }], { n: 5 }, { n: '5' })).toEqual([]);
  });
  it('a partial update that leaves the setting out changes nothing, a replacement that drops it does', () => {
    expect(guardedChanges(schema, { command: 'uptime' }, { interval: 10 })).toEqual([]);
    expect(guardedChanges(schema, { command: 'uptime' }, { interval: 10 }, true)).toHaveLength(1);
    expect(guardedChanges(schema, {}, { interval: 10 }, true)).toEqual([]);
  });
  it('setting a command on a widget that had none counts', () => {
    expect(guardedChanges(schema, {}, { command: 'id' })).toHaveLength(1);
  });
  it('ignores garbage input', () => {
    expect(guardedChanges(schema, null, 'x')).toEqual([]);
    expect(guardedChanges(schema, [], [])).toEqual([]);
  });
});
