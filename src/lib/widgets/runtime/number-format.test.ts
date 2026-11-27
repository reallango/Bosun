import { describe, it, expect } from 'vitest';
import { formatNumber, formatPercent, formatValueText, numberOf } from './number-format';

describe('numberOf', () => {
  it('reads the text of one finite number, and nothing else', () => {
    expect(numberOf('89.9')).toBe(89.9);
    expect(numberOf(' 100 ')).toBe(100);
    expect(numberOf('1e3')).toBe(1000);
    expect(numberOf('')).toBeNull();
    expect(numberOf('n/a')).toBeNull();
    expect(numberOf('12 MB')).toBeNull();
    expect(numberOf('Infinity')).toBeNull();
  });
});

describe('formatNumber', () => {
  it('keeps at most the asked decimals and drops a trailing .0', () => {
    expect(formatNumber(89.94, 1)).toBe('89.9');
    expect(formatNumber(89.9, 1)).toBe('89.9');
    expect(formatNumber(100, 1)).toBe('100');
    expect(formatNumber(0.8, 1)).toBe('0.8');
    expect(formatNumber(0, 1)).toBe('0');
    expect(formatNumber(45.4, 0)).toBe('45');
    expect(formatNumber(12.5, 2)).toBe('12.5');
    expect(formatNumber(99.99, 1)).toBe('100');
  });

  it('never writes a negative zero and clamps the decimals to 0-3', () => {
    expect(formatNumber(-0.04, 1)).toBe('0');
    expect(formatNumber(1.2345, 9)).toBe('1.235');
  });
});

describe('formatPercent', () => {
  it('shows at most one decimal by default', () => {
    expect(formatPercent(8)).toBe('8');
    expect(formatPercent(0.8)).toBe('0.8');
    expect(formatPercent(89.94)).toBe('89.9');
    expect(formatPercent(99.9)).toBe('99.9');
  });

  it('shows a whole number from 100 up, including one reached by rounding', () => {
    expect(formatPercent(100)).toBe('100');
    expect(formatPercent(100.0)).toBe('100');
    expect(formatPercent(99.99)).toBe('100');
    expect(formatPercent(100, 2)).toBe('100');
  });

  it('honours an explicit decimal count below 100', () => {
    expect(formatPercent(89.94, 2)).toBe('89.94');
    expect(formatPercent(45.4, 0)).toBe('45');
  });
});

describe('formatValueText', () => {
  it('formats a numeric string as well as a number', () => {
    expect(formatValueText('89.94', '%', undefined)).toBe('89.9');
    expect(formatValueText('89.94', '%', undefined)).toBe(formatValueText(String(89.94), '%', undefined));
    expect(formatValueText('100.0', '%', undefined)).toBe('100');
  });

  it('leaves values of other units alone unless the item asks for decimals', () => {
    expect(formatValueText('1023', 'MB', undefined)).toBe('1023');
    expect(formatValueText('12.5', 'GB', undefined)).toBe('12.5');
    expect(formatValueText('45', '°C', undefined)).toBe('45');
    expect(formatValueText('45.4', '°C', 0)).toBe('45');
    expect(formatValueText('12.55', 'GB', 1)).toBe('12.6');
  });

  it('leaves text that is not a number untouched', () => {
    expect(formatValueText('n/a', '%', undefined)).toBe('n/a');
    expect(formatValueText('', '%', undefined)).toBe('');
    expect(formatValueText('—', '%', undefined)).toBe('—');
  });
});
