import { describe, it, expect } from 'vitest';
import {
  GAUGE_VALUE_FLOOR_REM, TILE_VALUE_FLOOR_REM, fitGaugeValues, fitTileValues, gaugeFitCqmin, gaugeLabelFontSize, gaugeValueFontSize,
  labelFontSize, longestValueLength, textLength, tileFitCqw, tileValueFontSize, unitOnOwnLine,
  validateBlockSizing, validateDecimals, validateDensity, validateEmphasis, validateGaugeThickness,
} from './sizing';

describe('textLength and longestValueLength', () => {
  it('counts characters, not bytes', () => {
    expect(textLength('89.9%')).toBe(5);
    expect(textLength('45°C')).toBe(4);
  });

  it('takes the widest value of a block, and at least 1', () => {
    expect(longestValueLength([])).toBe(1);
    expect(longestValueLength(['8%', '89.9%', '100%'])).toBe(5);
    expect(longestValueLength(['1023 MB', '45°C'])).toBe(7);
  });
});

describe('the fit calculation', () => {
  it('leaves a short value at the container size', () => {
    expect(tileValueFontSize(2)).toContain('min(max(15cqw,25cqmin), calc(70cqw), 6rem)');
    expect(gaugeValueFontSize(2)).toContain('min(24cqmin, calc(46cqmin), 3.5rem)');
  });

  it('shrinks a longer value', () => {
    expect(tileFitCqw(5)).toBe(28);
    expect(gaugeFitCqmin(5)).toBe(18.4);
    expect(gaugeValueFontSize(5)).toContain('calc(18.4cqmin)');
    expect(tileValueFontSize(7)).toContain('calc(20cqw)');
  });

  it('keeps the estimated text width inside the room at every length', () => {
    for (let chars = 1; chars <= 40; chars++) {
      // A tabular digit is about 0.6 em wide. A tile's padding leaves ~85% of its width for the value; a ring's
      // inner circle is 88%, 80% or 68% of its box depending on the stroke, and the text may use ~70% of that.
      expect(0.6 * tileFitCqw(chars) * chars).toBeLessThanOrEqual(84.5);
      for (const stroke of [6, 10, 16]) {
        expect(0.6 * Math.min(gaugeFitCqmin(chars, stroke), 24) * chars).toBeLessThanOrEqual(0.7 * (100 - 2 * stroke));
      }
    }
  });

  it('scales the value and label with the block size', () => {
    expect(tileValueFontSize(5, 'lg')).toContain('calc(1.2 *');
    expect(tileValueFontSize(5, 'sm')).toContain('calc(0.85 *');
    expect(gaugeValueFontSize(5, 'lg')).toContain('calc(1.2 *');
    expect(gaugeValueFontSize(5, 'md', 16)).toContain('calc(15.64cqmin)');
    expect(labelFontSize('sm')).toContain('calc(0.85 *');
    expect(labelFontSize('md')).toContain('calc(1 *');
    expect(gaugeLabelFontSize('lg')).toContain('calc(1.2 *');
  });
});

describe('the readable floor and the split decision', () => {
  const smallTile = { width: 56, height: 60 };
  const largeTile = { width: 156, height: 154 };
  const smallRing = { width: 56, height: 60, stroke: 10 };
  const largeRing = { width: 154, height: 154, stroke: 10 };

  it('never goes below the readable floor', () => {
    const tile = fitTileValues([{ number: '1234567890', unit: 'MB' }], { width: 10, height: 10 });
    expect(tile.fontSize).toContain(`${TILE_VALUE_FLOOR_REM}rem`);
    expect(tile.fontSize).toContain('14.4px');
    const gauge = fitGaugeValues([{ number: '1234567890', unit: 'MB' }], { width: 10, height: 10 });
    expect(gauge.fontSize).toContain(`${GAUGE_VALUE_FLOOR_REM}rem`);
    expect(gauge.fontSize).toContain('12px');
  });

  it('splits a long unit in a small tile and keeps one line in a large one', () => {
    const small = fitTileValues([{ number: '1023', unit: 'MB' }], smallTile);
    expect(small.split).toBe(true);
    expect(unitOnOwnLine('MB', small)).toBe(true);
    expect(small.fontSize).toContain('14.4px');
    expect(small.unitFontSize).toContain('10.08px');

    const large = fitTileValues([{ number: '1023', unit: 'MB' }], largeTile);
    expect(large.split).toBe(false);
    expect(unitOnOwnLine('MB', large)).toBe(false);
    expect(large.fontSize).toContain('31.2px');
  });

  it('splits a gauge value only where the ring is too small for it', () => {
    const small = fitGaugeValues([{ number: '1023', unit: 'MB' }], smallRing);
    expect(small.split).toBe(true);
    expect(small.fontSize).toContain('12.88px');
    expect(unitOnOwnLine('MB', small)).toBe(true);

    const large = fitGaugeValues([{ number: '1023', unit: 'MB' }], largeRing);
    expect(large.split).toBe(false);
    expect(unitOnOwnLine('MB', large)).toBe(false);
  });

  it('keeps % on the number line unless the bare number cannot reach the floor', () => {
    const attached = fitTileValues([{ number: '89.9', unit: '%' }], { width: 44, height: 50 });
    expect(attached.split).toBe(true);
    expect(attached.splitPercent).toBe(false);
    expect(unitOnOwnLine('%', attached)).toBe(false);

    const moved = fitTileValues([{ number: '89.9', unit: '%' }], { width: 30, height: 40 });
    expect(moved.split).toBe(true);
    expect(moved.splitPercent).toBe(true);
    expect(unitOnOwnLine('%', moved)).toBe(true);
  });

  it('shares one decision across a block', () => {
    const values = [
      { number: '1023', unit: 'MB' }, { number: '12.5', unit: 'GB' }, { number: '45', unit: '°C' },
      { number: '89.9', unit: '%' }, { number: '100', unit: '%' },
    ];
    const fit = fitTileValues(values, smallTile);
    expect(fit.split).toBe(true);
    expect(unitOnOwnLine('MB', fit)).toBe(true);
    expect(unitOnOwnLine('°C', fit)).toBe(true);
    expect(unitOnOwnLine('%', fit)).toBe(false);
    expect(unitOnOwnLine(undefined, fit)).toBe(false);
  });

  it('uses the CSS fallback before the card has been measured', () => {
    const fit = fitTileValues([{ number: '1023', unit: 'MB' }], { width: 0, height: 0 });
    expect(fit.split).toBe(false);
    expect(fit.fontSize).toBe(tileValueFontSize(7));
  });
});

describe('validateBlockSizing', () => {
  it('accepts each key and keeps it', () => {
    expect(validateBlockSizing({ size: 'lg', minItemWidth: 'sm', columns: 3 }, 'x')).toEqual({
      ok: true, value: { size: 'lg', minItemWidth: 'sm', columns: 3 },
    });
    expect(validateBlockSizing({}, 'x')).toEqual({ ok: true, value: {} });
  });

  it('refuses unknown values with a clear message', () => {
    expect(validateBlockSizing({ size: 'xl' }, 'block')).toEqual({ ok: false, error: 'block: "size" must be one of sm, md, lg' });
    expect(validateBlockSizing({ minItemWidth: 'huge' }, 'block')).toEqual({
      ok: false, error: 'block: "minItemWidth" must be one of xs, sm, md, lg',
    });
    for (const columns of [0, 7, 2.5, '3', null]) {
      expect(validateBlockSizing({ columns }, 'block').ok, String(columns)).toBe(false);
    }
  });
});

describe('item and widget keys', () => {
  it('validate decimals', () => {
    expect(validateDecimals(undefined, 'x')).toEqual({ ok: true, value: undefined });
    expect(validateDecimals(0, 'x')).toEqual({ ok: true, value: 0 });
    expect(validateDecimals(3, 'x')).toEqual({ ok: true, value: 3 });
    for (const bad of [-1, 4, 1.5, '2', null]) {
      expect(validateDecimals(bad, 'stat "CPU"')).toEqual({ ok: false, error: 'stat "CPU": "decimals" must be a whole number from 0 to 3' });
    }
  });

  it('validate emphasis', () => {
    expect(validateEmphasis(undefined, 'x')).toEqual({ ok: true, value: undefined });
    expect(validateEmphasis('muted', 'x')).toEqual({ ok: true, value: 'muted' });
    expect(validateEmphasis('loud', 'gauge "CPU"')).toEqual({
      ok: false, error: 'gauge "CPU": "emphasis" must be one of normal, muted',
    });
  });

  it('validate a ring thickness', () => {
    expect(validateGaugeThickness(undefined, 'x')).toEqual({ ok: true, value: undefined });
    expect(validateGaugeThickness('thick', 'x')).toEqual({ ok: true, value: 'thick' });
    expect(validateGaugeThickness('wide', 'block')).toEqual({
      ok: false, error: 'block: "thickness" must be one of thin, normal, thick',
    });
  });

  it('validate the widget density', () => {
    expect(validateDensity(undefined)).toEqual({ ok: true, value: undefined });
    expect(validateDensity('compact')).toEqual({ ok: true, value: 'compact' });
    expect(validateDensity('dense')).toEqual({ ok: false, error: 'spec: "density" must be one of comfortable, compact' });
  });
});
