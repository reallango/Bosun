import { describe, it, expect } from 'vitest';
import { UpdateError } from './errors';
import {
  previousCommit, rollbackImageProblem, rollbackTarget, rolloutRunning, sameCommit, usableCommit,
  type RolloutRecord,
} from './rollback';

const OLD = 'aaaaaaa111111111111111111111111111111111';
const NEW = 'bbbbbbb222222222222222222222222222222222';
const OTHER = 'ccccccc333333333333333333333333333333333';
const NOW = Date.parse('2026-05-01T12:00:00.000Z');
const MINUTE = 60_000;

const rollout = (over: Partial<RolloutRecord> = {}): RolloutRecord => ({
  target: NEW, status: 'done', started_at: '2026-05-01T10:00:00.000Z', finished_at: '2026-05-01T10:10:00.000Z',
  kind: 'update', from: OLD, ...over,
});

describe('commit names', () => {
  it('accepts short and full SHAs, and nothing else', () => {
    expect(usableCommit(OLD)).toBe(OLD);
    expect(usableCommit(OLD.slice(0, 7))).toBe(OLD.slice(0, 7));
    expect(usableCommit(' ABCDEF0 ')).toBe('abcdef0');
    for (const bad of ['unknown', '', null, undefined, '$(reboot)', 'not-a-commit']) expect(usableCommit(bad), String(bad)).toBeNull();
  });

  it('matches a short commit with its full form', () => {
    expect(sameCommit(OLD, OLD.slice(0, 7))).toBe(true);
    expect(sameCommit(OLD.slice(0, 7), OLD)).toBe(true);
    expect(sameCommit(OLD, NEW)).toBe(false);
    expect(sameCommit(OLD, 'unknown')).toBe(false);
    expect(sameCommit(null, null)).toBe(false);
  });
});

describe('the previous commit of a rollout', () => {
  it('is the commit a finished update came from', () => {
    expect(previousCommit(rollout())).toBe(OLD);
    expect(previousCommit(rollout({ kind: 'rollback', target: OLD, from: NEW }))).toBe(NEW);
  });

  it('also undoes a rollout that stopped', () => {
    expect(previousCommit(rollout({ status: 'failed' }))).toBe(OLD);
  });

  it('is not available while a rollout is still running, unless its record is stale', () => {
    expect(previousCommit(rollout({ status: 'running', finished_at: null, started_at: new Date(NOW - MINUTE).toISOString() }), NOW)).toBeNull();
    expect(previousCommit(rollout({ status: 'running', finished_at: null, started_at: '2026-05-01T09:00:00.000Z' }), NOW)).toBe(OLD);
  });

  it('is not available when the record has no origin or names the same version', () => {
    expect(previousCommit(null)).toBeNull();
    expect(previousCommit(rollout({ from: null }))).toBeNull();
    expect(previousCommit(rollout({ from: 'unknown' }))).toBeNull();
    expect(previousCommit(rollout({ from: NEW }))).toBeNull();
    expect(previousCommit(rollout({ from: NEW.slice(0, 7) }))).toBeNull();
    expect(previousCommit(rollout({ finished_at: null }))).toBeNull();
  });
});

describe('the target of a rollback', () => {
  it('is the previous commit, with its published sha-<7> image', () => {
    expect(rollbackTarget(rollout(), 'ghcr.io/reallango/bosun', NOW)).toEqual({
      target: OLD,
      image: 'ghcr.io/reallango/bosun:sha-aaaaaaa',
    });
  });

  it('refuses while an update is running', () => {
    const running = rollout({ status: 'running', finished_at: null, started_at: new Date(NOW - MINUTE).toISOString() });
    expect(rolloutRunning(running, NOW)).toBe(true);
    expect(() => rollbackTarget(running, 'ghcr.io/reallango/bosun', NOW)).toThrow(UpdateError);
    try { rollbackTarget(running, 'ghcr.io/reallango/bosun', NOW); } catch (e) {
      expect((e as UpdateError).code).toBe('UPDATE_RUNNING');
      expect((e as UpdateError).status).toBe(409);
    }
  });

  it('refuses when there is no previous commit', () => {
    for (const r of [null, rollout({ from: null }), rollout({ from: 'unknown' }), rollout({ from: NEW })]) {
      try { rollbackTarget(r, 'ghcr.io/reallango/bosun', NOW); expect.unreachable('should refuse'); } catch (e) {
        expect(e).toBeInstanceOf(UpdateError);
        expect((e as UpdateError).code).toBe('NO_PREVIOUS');
      }
    }
  });
});

describe('the image a rollback needs', () => {
  const image = 'ghcr.io/reallango/bosun:sha-aaaaaaa';

  it('is accepted when the registry still has that commit', () => {
    expect(rollbackImageProblem({ commit: OLD }, OLD, image)).toBeNull();
    expect(rollbackImageProblem({ commit: OLD.slice(0, 7) }, OLD, image)).toBeNull();
  });

  it('is refused with a clear message when the tag is gone', () => {
    expect(rollbackImageProblem(null, OLD, image)).toContain('no image');
    expect(rollbackImageProblem({ commit: null }, OLD, image)).toContain('aaaaaaa');
  });

  it('is refused when the tag points at another commit', () => {
    expect(rollbackImageProblem({ commit: OTHER }, OLD, image)).toContain(OTHER.slice(0, 7));
    expect(rollbackImageProblem({ commit: OTHER }, OLD, image)).toContain(OLD.slice(0, 7));
  });
});
