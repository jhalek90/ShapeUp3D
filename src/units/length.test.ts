import { describe, expect, it } from 'vitest';
import { formatLength, parseLength, parseLengthList } from './length';

describe('parseLength', () => {
  it('uses the default unit for bare numbers', () => {
    expect(parseLength('25', 'mm')).toBe(25);
    expect(parseLength('2.5', 'cm')).toBe(25);
    expect(parseLength('1.5', 'm')).toBe(1500);
    expect(parseLength('1', 'in')).toBeCloseTo(25.4);
  });

  it('treats bare numbers as inches in feet mode', () => {
    expect(parseLength('6', 'ft')).toBeCloseTo(152.4);
  });

  it('accepts explicit units regardless of default', () => {
    expect(parseLength('25mm', 'in')).toBe(25);
    expect(parseLength('2.5 cm', 'mm')).toBe(25);
    expect(parseLength('1.5m', 'mm')).toBe(1500);
    expect(parseLength('1"', 'mm')).toBeCloseTo(25.4);
    expect(parseLength('2 inches', 'mm')).toBeCloseTo(50.8);
    expect(parseLength("1'", 'mm')).toBeCloseTo(304.8);
    expect(parseLength('2 ft', 'mm')).toBeCloseTo(609.6);
  });

  it('parses feet and inches', () => {
    expect(parseLength(`3'6"`, 'mm')).toBeCloseTo(1066.8);
    expect(parseLength(`3' 6"`, 'mm')).toBeCloseTo(1066.8);
    expect(parseLength(`3'6`, 'mm')).toBeCloseTo(1066.8);
    expect(parseLength(`3' 6 1/2"`, 'mm')).toBeCloseTo(1079.5);
  });

  it('parses fractions and leading decimals', () => {
    expect(parseLength('1/2"', 'mm')).toBeCloseTo(12.7);
    expect(parseLength('6 1/2', 'in')).toBeCloseTo(165.1);
    expect(parseLength('.5', 'mm')).toBe(0.5);
  });

  it('handles sign and whitespace', () => {
    expect(parseLength('  -10 mm ', 'mm')).toBe(-10);
    expect(parseLength('+10', 'mm')).toBe(10);
  });

  it('rejects invalid input', () => {
    for (const bad of ['', 'abc', '10 xyz', '1/0', `3mm 6"`, `3' 2mm`, '1..2', '--5']) {
      expect(parseLength(bad, 'mm'), bad).toBeNull();
    }
  });
});

describe('parseLengthList', () => {
  it('splits on commas and semicolons', () => {
    expect(parseLengthList('30,20', 'mm')).toEqual([30, 20]);
    expect(parseLengthList('3cm; 2cm', 'mm')).toEqual([30, 20]);
  });

  it('keeps empty entries as null', () => {
    expect(parseLengthList(',20', 'mm')).toEqual([null, 20]);
  });

  it('fails if any entry is invalid', () => {
    expect(parseLengthList('30,abc', 'mm')).toBeNull();
  });
});

describe('formatLength', () => {
  it('formats metric units', () => {
    expect(formatLength(25, { unit: 'mm', precision: 1 })).toBe('25 mm');
    expect(formatLength(25.25, { unit: 'mm', precision: 2 })).toBe('25.25 mm');
    expect(formatLength(1500, { unit: 'm', precision: 2 })).toBe('1.5 m');
    expect(formatLength(25, { unit: 'cm', precision: 1 })).toBe('2.5 cm');
  });

  it('marks rounded values with ~', () => {
    expect(formatLength(10.123, { unit: 'mm', precision: 1 })).toBe('~ 10.1 mm');
  });

  it('formats inches and feet', () => {
    expect(formatLength(25.4, { unit: 'in', precision: 2 })).toBe('1"');
    expect(formatLength(1066.8, { unit: 'ft', precision: 2 })).toBe(`3' 6"`);
    expect(formatLength(152.4, { unit: 'ft', precision: 2 })).toBe('6"');
    expect(formatLength(304.8, { unit: 'ft', precision: 2 })).toBe(`1' 0"`);
  });

  it('carries inches that round up to a full foot', () => {
    expect(formatLength(304.79, { unit: 'ft', precision: 1 })).toBe(`~ 1' 0"`);
  });

  it('formats negatives without "-0"', () => {
    expect(formatLength(-10, { unit: 'mm', precision: 0 })).toBe('-10 mm');
    expect(formatLength(-0.5, { unit: 'mm', precision: 1 })).toBe('-0.5 mm');
    expect(formatLength(-0.001, { unit: 'mm', precision: 1 })).toBe('~ 0 mm');
    expect(formatLength(-0.001, { unit: 'ft', precision: 1 })).toBe('~ 0"');
  });
});
