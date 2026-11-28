import { describe, it, expect } from 'vitest';
import {
  clusterMinimumLevel, nodesBehind, clusterCanRun, clusterLevelProblem, describeNodesBehind, type NodeApiLevel,
} from './cluster-level';

const node = (id: string, level: number | null): NodeApiLevel => ({ id, level });

describe('clusterMinimumLevel', () => {
  it('is the lowest level among the voters', () => {
    expect(clusterMinimumLevel([node('a', 9), node('b', 8), node('c', 10)])).toBe(8);
  });

  it('is null when a voter is unreachable or runs an old build without the field', () => {
    expect(clusterMinimumLevel([node('a', 9), node('b', null)])).toBeNull();
  });

  it('is the node’s own level for a single-node install', () => {
    expect(clusterMinimumLevel([node('a', 9)])).toBe(9);
  });

  it('is null for an empty list (nothing can be confirmed)', () => {
    expect(clusterMinimumLevel([])).toBeNull();
  });

  it('ignores a node that left the cluster (it is not in the voter list)', () => {
    // The old node b is gone; only a and c remain.
    expect(clusterMinimumLevel([node('a', 9), node('c', 9)])).toBe(9);
  });
});

describe('nodesBehind', () => {
  it('names voters below the required level and those whose level is unknown', () => {
    expect(nodesBehind([node('a', 9), node('b', 8), node('c', null)], 9)).toEqual([node('b', 8), node('c', null)]);
  });

  it('is empty when every voter is at or above the level', () => {
    expect(nodesBehind([node('a', 9), node('b', 10)], 9)).toEqual([]);
  });

  it('is empty for a package that needs level 1', () => {
    expect(nodesBehind([node('a', null)], 1)).toEqual([]);
  });
});

describe('clusterCanRun', () => {
  it('always allows a package without a requirement', () => {
    expect(clusterCanRun(1, null)).toBe(true);
    expect(clusterCanRun(1, 1)).toBe(true);
  });

  it('allows a package at the cluster minimum', () => {
    expect(clusterCanRun(9, 9)).toBe(true);
    expect(clusterCanRun(8, 9)).toBe(true);
  });

  it('refuses a package above the minimum, or when the minimum is unknown', () => {
    expect(clusterCanRun(9, 8)).toBe(false);
    expect(clusterCanRun(9, null)).toBe(false);
  });
});

describe('clusterLevelProblem', () => {
  it('names the nodes that are behind, including one whose level is unknown', () => {
    expect(clusterLevelProblem(9, [node('a', 9), node('b', 8), node('c', null)])).toBe(
      'This package needs widget API level 9, but these cluster nodes cannot run it: b (level 8), c (level unknown). Finish updating the cluster first.',
    );
  });

  it('is null when the whole cluster can run it', () => {
    expect(clusterLevelProblem(9, [node('a', 9), node('b', 9)])).toBeNull();
    expect(clusterLevelProblem(1, [node('a', null)])).toBeNull();
  });

  it('describes a node whose level is unknown', () => {
    expect(describeNodesBehind([node('a', null)])).toBe('a (level unknown)');
  });
});
