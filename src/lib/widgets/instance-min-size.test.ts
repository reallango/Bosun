import { describe, it, expect } from 'vitest';
import { applyLookMinSize, minSizeStatements, parseMinSize, type MinSizeRow } from './instance-min-size';

const row = (over: Partial<MinSizeRow> = {}): MinSizeRow => ({
  id: 'w1', widget_type: 'cpu_memory', grid_min_w: 4, grid_min_h: 5, ...over,
});

const declared = (w: number, h: number) => new Map([['cpu_memory', { w, h }]]);

describe('parseMinSize', () => {
  it('reads a stored min_size', () => {
    expect(parseMinSize('{"w":4,"h":3}')).toEqual({ w: 4, h: 3 });
    expect(parseMinSize('{"w":6.4,"h":2.6}')).toEqual({ w: 6, h: 3 });
  });

  it('falls back to the installer default when the value is missing or unreadable', () => {
    expect(parseMinSize(null)).toEqual({ w: 4, h: 4 });
    expect(parseMinSize('not json')).toEqual({ w: 4, h: 4 });
    expect(parseMinSize('{"w":"x","h":3}')).toEqual({ w: 4, h: 4 });
  });
});

describe('lowering the minimum stored on widget instances', () => {
  it('lowers a stored minimum that is above the package minimum, in both directions', () => {
    expect(minSizeStatements([row()], declared(4, 3))).toEqual([
      { sql: 'UPDATE widgets SET grid_min_w = ?, grid_min_h = ? WHERE id = ?', params: [4, 3, 'w1'] },
    ]);
    expect(minSizeStatements([row({ grid_min_w: 8, grid_min_h: 6 })], declared(4, 3))[0].params).toEqual([4, 3, 'w1']);
  });

  it('lowers only the axis that is above the new minimum', () => {
    expect(minSizeStatements([row({ grid_min_w: 4, grid_min_h: 5 })], declared(4, 3))[0].params).toEqual([4, 3, 'w1']);
    expect(minSizeStatements([row({ grid_min_w: 6, grid_min_h: 3 })], declared(4, 3))[0].params).toEqual([4, 3, 'w1']);
  });

  it('never raises a minimum when the package needs more room', () => {
    expect(minSizeStatements([row({ grid_min_w: 2, grid_min_h: 2 })], declared(6, 5))).toEqual([]);
  });

  it('leaves an instance that already matches alone, and ignores types this package does not declare', () => {
    expect(minSizeStatements([row({ grid_min_w: 4, grid_min_h: 3 })], declared(4, 3))).toEqual([]);
    expect(minSizeStatements([row({ widget_type: 'other_widget' })], declared(4, 3))).toEqual([]);
  });

  it('handles several instances independently', () => {
    const rows = [row({ id: 'a' }), row({ id: 'b', grid_min_h: 3 }), row({ id: 'c', grid_min_w: 2, grid_min_h: 9 })];
    expect(minSizeStatements(rows, declared(4, 3))).toEqual([
      { sql: 'UPDATE widgets SET grid_min_w = ?, grid_min_h = ? WHERE id = ?', params: [4, 3, 'a'] },
      { sql: 'UPDATE widgets SET grid_min_w = ?, grid_min_h = ? WHERE id = ?', params: [2, 3, 'c'] },
    ]);
  });

  it('keeps the floor an instance’s selected look asks for', () => {
    // cpu_memory declares 4x3, but its "cores" look needs 8x6: an instance on that look is at 8x6 (the settings route
    // put it there), and an upgrade must not lower it to 4x3, or the per-core grid can be shrunk below its floor.
    const looks = new Map([['cpu_memory', {
      default: 'tiles',
      options: [
        { id: 'tiles', label: 'Tiles' },
        { id: 'cores', label: 'Cores', min_size: { w: 8, h: 6 }, default_size: { w: 10, h: 6 } },
      ],
    }]]);
    const cores = row({ grid_min_w: 8, grid_min_h: 6, config: JSON.stringify({ look: 'cores' }) });
    expect(minSizeStatements([cores], declared(4, 3), looks)).toEqual([]);
    // The same instance on a look without a floor follows the package's new minimum.
    const tiles = row({ grid_min_w: 8, grid_min_h: 6, config: JSON.stringify({ look: 'tiles' }) });
    expect(minSizeStatements([tiles], declared(4, 3), looks)).toEqual([
      { sql: 'UPDATE widgets SET grid_min_w = ?, grid_min_h = ? WHERE id = ?', params: [4, 3, 'w1'] },
    ]);
    // No stored settings (or unreadable ones) fall back to the package's minimum.
    expect(minSizeStatements([row({ grid_min_w: 8, grid_min_h: 6, config: 'nonsense' })], declared(4, 3), looks)[0].params).toEqual([4, 3, 'w1']);
    expect(minSizeStatements([row({ grid_min_w: 8, grid_min_h: 6 })], declared(4, 3), looks)[0].params).toEqual([4, 3, 'w1']);
  });
});

describe('applyLookMinSize', () => {
  it('lowers and raises the floor with the look', () => {
    const current = { grid_min_w: 4, grid_min_h: 4, grid_w: 8, grid_h: 6 };
    expect(applyLookMinSize(current, { w: 2, h: 2 })).toEqual({ grid_min_w: 2, grid_min_h: 2, grid_w: 8, grid_h: 6 });
    expect(applyLookMinSize(current, { w: 6, h: 5 })).toEqual({ grid_min_w: 6, grid_min_h: 5, grid_w: 8, grid_h: 6 });
  });

  it('grows the instance when the new floor no longer fits', () => {
    const current = { grid_min_w: 2, grid_min_h: 2, grid_w: 3, grid_h: 2 };
    expect(applyLookMinSize(current, { w: 4, h: 3 })).toEqual({ grid_min_w: 4, grid_min_h: 3, grid_w: 4, grid_h: 3 });
  });

  it('returns null when the look does not change anything', () => {
    const current = { grid_min_w: 4, grid_min_h: 4, grid_w: 8, grid_h: 6 };
    expect(applyLookMinSize(current, { w: 4, h: 4 })).toBeNull();
    expect(applyLookMinSize(current, null)).toBeNull();
  });
});
